import { detectForWallet } from "../detection/detect.js";
import type { TransactionSnapshot } from "../detection/types.js";
import { dedupeKey, type TradeEvent } from "../types.js";
import type { Database } from "../db.js";
import type { DexScreenerPriceService } from "./pricing.js";
import type { CopyTradeService, Notify } from "./copytrade.js";
import type { PositionService } from "./positions.js";
import type { ActivityService } from "./activity.js";
import type { HealthService } from "./health.js";

const MIN_LIQUIDITY_USD = 1000;

export class TradingEngine {
  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly copyTrade: CopyTradeService,
    private readonly positions: PositionService,
    private readonly notify: Notify,
    private readonly watchedAddresses: () => ReadonlySet<string>,
    private readonly activity: ActivityService,
    private readonly health: HealthService,
  ) {}

  async processSnapshot(snapshot: TransactionSnapshot) {
    this.health.markChainEvent();
    for (const wallet of snapshot.signerAddresses) {
      if (!this.watchedAddresses().has(wallet)) continue;
      const trader = await this.db.getTraderByWallet(wallet, snapshot.chain);
      if (!trader) continue; // Never fall back to all users/chats.
      const configs = await this.db.configsForWallet(wallet);
      for (const config of configs) {
        await this.activity.emit({
          userId: config.userId,
          traderId: trader.id,
          type: "chain_transaction_received",
          message: `${config.traderHandle ? `@${config.traderHandle}` : config.traderName} transaction received on ${snapshot.chain}`,
          metadata: { chain: snapshot.chain, txHash: snapshot.txHash, wallet },
        });
      }
      const tracked = new Set(await this.db.listOpenLeaderTokens(trader.id, snapshot.chain));
      const candidates = detectForWallet(snapshot, wallet, tracked);

      for (const candidate of candidates) {
        if (candidate.requiresLiquidityCheck) {
          const market = await this.prices.getTokenMarket(candidate.token);
          if (!market || market.liquidityUsd < MIN_LIQUIDITY_USD) {
            for (const config of configs) {
              await this.activity.emit({
                userId: config.userId,
                traderId: trader.id,
                type: "copy_skipped",
                severity: "warning",
                message: `Skipped ${candidate.token}: insufficient liquidity for payment-less receive`,
                metadata: { chain: snapshot.chain, txHash: snapshot.txHash, token: candidate.token, liquidityUsd: market?.liquidityUsd ?? null },
              });
            }
            continue;
          }
        }

        const event: TradeEvent = {
          chain: snapshot.chain,
          txHash: snapshot.txHash,
          wallet,
          token: candidate.token,
          classification: candidate.classification,
          quoteAsset: candidate.quoteAsset,
          quoteAmountRaw: candidate.quoteAmountRaw,
          tokenAmountRaw: candidate.tokenAmountRaw,
          preTokenAmountRaw: candidate.preTokenAmountRaw,
          tokenDecimals: candidate.tokenDecimals,
          detectedAt: new Date(),
          requiresLiquidityCheck: candidate.requiresLiquidityCheck,
        };
        if (!(await this.db.insertSeenTrade(event, dedupeKey(event)))) continue;

        if (event.classification === "buy") {
          const observedKind = (candidate.preTokenAmountRaw ?? 0n) === 0n ? "new_entry" : "top_up";
          const kind = await this.db.classifyLeaderEntry(trader.id, event, observedKind);
          const market = await this.prices.getTokenMarket(event.token).catch(() => null);
          const tokenLabel = tokenDisplay(event.token, market);
          const traderAmount = formatTokenAmount(event.tokenAmountRaw, event.tokenDecimals, market?.symbol);
          for (const config of configs) {
            await this.activity.emit({
              userId: config.userId,
              traderId: trader.id,
              type: kind === "new_entry" ? "new_entry_detected" : "top_up_detected",
              severity: "success",
              message: `${kind === "new_entry" ? "NEW ENTRY" : "TOP-UP"} detected for ${config.traderHandle ? `@${config.traderHandle}` : config.traderName}`,
              metadata: { chain: event.chain, txHash: event.txHash, token: event.token, kind },
            });
            const mode = config.dryRun ? "Paper simulation" : "Live funds";
            const action =
              await this.db.isUserPaused(config.userId) ? "Will not copy: your account is paused." :
              kind === "new_entry" && !config.copyNewEntries ? "Will not copy: new-entry copying is disabled." :
              kind === "top_up" && !config.copyTopups ? "Will not copy: top-up copying is disabled." :
              config.dryRun ? `Will simulate a $${config.tradeAmountUsd.toFixed(2)} buy.` :
              `Will try a live $${config.tradeAmountUsd.toFixed(2)} buy.`;
            await this.notify(config.chatId,
              `${kind === "new_entry" ? "🟢 New entry detected" : "🟡 Top-up detected"}\n` +
              `Trader: ${config.traderHandle ? `@${config.traderHandle}` : config.traderName}\n` +
              `Meaning: ${kind === "new_entry" ? "first observed buy of this token" : "trader added more to a token they already held"}\n` +
              `Your mode: ${mode}\n` +
              `${action}\n` +
              `Token: ${tokenLabel}\n` +
              `Trader amount: ${traderAmount}\n` +
              `Source tx: ${solscanTx(event.txHash)}`,
            );
            await this.copyTrade.onEntry(config, event, kind);
          }
        } else if (event.classification === "full_exit") {
          await this.db.closeLeaderPosition(trader.id, event);
          for (const config of configs) {
            await this.activity.emit({
              userId: config.userId,
              traderId: trader.id,
              type: "leader_exit_detected",
              severity: "warning",
              message: `Leader exit detected for ${config.traderHandle ? `@${config.traderHandle}` : config.traderName}`,
              metadata: { chain: event.chain, txHash: event.txHash, token: event.token },
            });
            const market = await this.prices.getTokenMarket(event.token).catch(() => null);
            await this.notify(config.chatId,
              `🔔 Leader exit detected\n` +
              `Trader: ${config.traderHandle ? `@${config.traderHandle}` : config.traderName}\n` +
              `Meaning: the trader's token balance went to zero.\n` +
              `Mirror exits: ${config.mirrorExits ? "on" : "off"}\n` +
              `Token: ${tokenDisplay(event.token, market)}\n` +
              `Exited amount: ${formatTokenAmount(event.tokenAmountRaw, event.tokenDecimals, market?.symbol)}\n` +
              `Source tx: ${solscanTx(event.txHash)}`,
            );
            if (!config.mirrorExits || await this.db.isUserPaused(config.userId)) {
              await this.activity.emit({
                userId: config.userId,
                traderId: trader.id,
                type: "copy_skipped",
                message: `Leader exit not mirrored for ${event.token}`,
                metadata: { chain: event.chain, txHash: event.txHash, token: event.token, mirrorExits: config.mirrorExits },
              });
              continue;
            }
            const open = await this.db.listOpenPositionsForTrader(config.userId, trader.id, event.chain, event.token);
            for (const p of open) await this.positions.exit(config.userId, p.id, 100, "LEADER_EXIT");
          }
        }
      }
    }
  }
}

function shortAddress(value: string) {
  return value.length <= 16 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function solscanTx(signature: string) {
  return `https://solscan.io/tx/${signature}`;
}

function tokenDisplay(address: string, market: { symbol?: string; name?: string } | null) {
  if (market?.name && market?.symbol) return `${market.name} (${market.symbol})`;
  return market?.symbol ?? shortAddress(address);
}

function formatTokenAmount(raw: bigint | undefined, decimals: number | undefined, symbol: string | undefined) {
  if (raw == null || decimals == null) return "unknown";
  const value = Number(raw) / 10 ** decimals;
  const formatted = value >= 1 ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  return symbol ? `${formatted} ${symbol}` : formatted;
}
