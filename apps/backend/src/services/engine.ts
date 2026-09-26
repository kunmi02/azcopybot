import { detectForWallet } from "../detection/detect.js";
import type { TransactionSnapshot } from "../detection/types.js";
import { dedupeKey, type TradeEvent } from "../types.js";
import type { Database } from "../db.js";
import type { DexScreenerPriceService } from "./pricing.js";
import type { CopyTradeService, Notify } from "./copytrade.js";
import type { PositionService } from "./positions.js";

const MIN_LIQUIDITY_USD = 1000;

export class TradingEngine {
  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly copyTrade: CopyTradeService,
    private readonly positions: PositionService,
    private readonly notify: Notify,
    private readonly watchedAddresses: () => ReadonlySet<string>,
  ) {}

  async processSnapshot(snapshot: TransactionSnapshot) {
    for (const wallet of snapshot.signerAddresses) {
      if (!this.watchedAddresses().has(wallet)) continue;
      const trader = await this.db.getTraderByWallet(wallet, snapshot.chain);
      if (!trader) continue; // Never fall back to all users/chats.
      const tracked = new Set(await this.db.listOpenLeaderTokens(trader.id, snapshot.chain));
      const candidates = detectForWallet(snapshot, wallet, tracked);

      for (const candidate of candidates) {
        if (candidate.requiresLiquidityCheck) {
          const market = await this.prices.getTokenMarket(candidate.token);
          if (!market || market.liquidityUsd < MIN_LIQUIDITY_USD) continue;
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
          detectedAt: new Date(),
          requiresLiquidityCheck: candidate.requiresLiquidityCheck,
        };
        if (!(await this.db.insertSeenTrade(event, dedupeKey(event)))) continue;

        const configs = await this.db.configsForWallet(wallet);
        if (event.classification === "buy") {
          const observedKind = (candidate.preTokenAmountRaw ?? 0n) === 0n ? "new_entry" : "top_up";
          const kind = await this.db.classifyLeaderEntry(trader.id, event, observedKind);
          for (const config of configs) {
            await this.notify(config.chatId, `⚡ ${kind === "new_entry" ? "NEW ENTRY" : "TOP-UP"} detected\n${config.traderHandle ? `@${config.traderHandle}` : config.traderName}\nToken: ${event.token}\nTX: ${event.txHash}`);
            await this.copyTrade.onEntry(config, event, kind);
          }
        } else if (event.classification === "full_exit") {
          await this.db.closeLeaderPosition(trader.id, event);
          for (const config of configs) {
            await this.notify(config.chatId, `🔔 Leader exit detected\n${config.traderHandle ? `@${config.traderHandle}` : config.traderName}\nToken: ${event.token}`);
            if (!config.mirrorExits || await this.db.isUserPaused(config.userId)) continue;
            const open = await this.db.listOpenPositionsForTrader(config.userId, trader.id, event.chain, event.token);
            for (const p of open) await this.positions.exit(config.userId, p.id, 100, "LEADER_EXIT");
          }
        }
      }
    }
  }
}
