import type { Database } from "../db.js";
import type { CopyConfig, EntryKind, TradeEvent } from "../types.js";
import type { DexScreenerPriceService } from "./pricing.js";
import type { SolanaExecutor } from "../execution/solana.js";
import { SubmissionUnknownError } from "../execution/submit.js";
import type { ActivityService } from "./activity.js";

export type Notify = (chatId: string, text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>) => Promise<void>;

export class CopyTradeService {
  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly executor: SolanaExecutor,
    private readonly notify: Notify,
    private readonly activity: ActivityService,
  ) {}

  async onEntry(config: CopyConfig & { chatId: string; traderHandle: string | null; traderName: string; traderId: string }, event: TradeEvent, kind: EntryKind) {
    const traderName = config.traderHandle ? `@${config.traderHandle}` : config.traderName;
    if (await this.db.isUserPaused(config.userId)) {
      await this.activity.emit({ userId: config.userId, traderId: config.traderId, type: "copy_skipped", message: `Skipped ${event.token}: user paused new entries`, metadata: { token: event.token, txHash: event.txHash } });
      await this.notify(config.chatId,
        `⏸️ Copy skipped\nTrader: ${traderName}\nReason: your account is paused for new entries.\nToken: ${shortAddress(event.token)}\nSource tx: ${solscanTx(event.txHash)}`,
      );
      return;
    }
    if (kind === "new_entry" && !config.copyNewEntries) {
      await this.activity.emit({ userId: config.userId, traderId: config.traderId, type: "copy_skipped", message: `Skipped ${event.token}: new-entry copying disabled`, metadata: { token: event.token, txHash: event.txHash } });
      await this.notify(config.chatId,
        `⏭️ Copy skipped\nTrader: ${traderName}\nReason: new-entry copying is disabled for this config.\nToken: ${shortAddress(event.token)}\nSource tx: ${solscanTx(event.txHash)}`,
      );
      return;
    }
    if (kind === "top_up" && !config.copyTopups) {
      await this.activity.emit({ userId: config.userId, traderId: config.traderId, type: "copy_skipped", message: `Skipped ${event.token}: top-up copying disabled`, metadata: { token: event.token, txHash: event.txHash } });
      await this.notify(config.chatId,
        `⏭️ Top-up skipped\nTrader: ${traderName}\nReason: top-up copying is disabled. The trader added to an existing token position, but this bot only copies new entries by default.\nToken: ${shortAddress(event.token)}\nSource tx: ${solscanTx(event.txHash)}`,
      );
      return;
    }
    if (event.chain !== "solana") {
      await this.activity.emit({ userId: config.userId, traderId: config.traderId, type: "copy_skipped", message: `Skipped ${event.token}: ${event.chain} execution is not enabled in V1`, metadata: { token: event.token, txHash: event.txHash, chain: event.chain } });
      return;
    }

    const market = await this.prices.getTokenMarket(event.token);
    if (!market || market.priceUsd <= 0) {
      await this.activity.emit({ userId: config.userId, traderId: config.traderId, type: "copy_skipped", severity: "warning", message: `Skipped ${event.token}: no reliable price available`, metadata: { token: event.token, txHash: event.txHash } });
      await this.notify(config.chatId, `⚠️ ${config.traderHandle ?? config.traderName}: entry detected but no reliable price was available for ${event.token}. Skipped.`);
      return;
    }

    if (config.dryRun) {
      const qty = config.tradeAmountUsd / market.priceUsd;
      const tokenLabel = tokenDisplay(event.token, market);
      const copiedAmount = formatNumber(qty, market.symbol);
      const position = await this.db.createPosition({
        userId: config.userId,
        traderId: config.traderId,
        configId: config.id,
        copyWalletId: config.tradingWalletId,
        chain: event.chain,
        token: event.token,
        qty,
        costUsd: config.tradeAmountUsd,
        entryPrice: market.priceUsd,
        mode: "paper",
      });
      const executionId = await this.db.createExecution({
        userId: config.userId, positionId: position.id, traderId: config.traderId, sourceTxHash: event.txHash,
        chain: event.chain, token: event.token, side: "buy", reason: `COPY_${kind.toUpperCase()}`,
        requestedUsd: config.tradeAmountUsd, actualUsd: config.tradeAmountUsd, tokenQty: qty,
        executionPrice: market.priceUsd, status: "paper",
      });
      await this.activity.emit({
        userId: config.userId,
        traderId: config.traderId,
        positionId: position.id,
        executionId,
        type: "paper_buy_created",
        severity: "success",
        message: `Paper entry created for ${market.symbol ?? event.token}`,
        metadata: { token: event.token, amountUsd: config.tradeAmountUsd, kind },
      });
      await this.notify(config.chatId,
        `🟡 Paper position opened\n` +
        `Trader: ${traderName}\n` +
        `Trigger: ${kind === "new_entry" ? "new entry" : "top-up"}\n` +
        `Action: simulated $${config.tradeAmountUsd.toFixed(2)} buy. No real funds moved.\n` +
        `Token: ${tokenLabel}\n` +
        `Simulated amount: ${copiedAmount}\n` +
        `Entry price: $${market.priceUsd}\n` +
        `TP: ${config.takeProfitPct ?? "off"}% · SL: ${config.stopLossPct ?? "off"}%\n` +
        `Source tx: ${solscanTx(event.txHash)}`,
        [[{ text: "View position", callback_data: `position:${position.id}` }, { text: "Exit paper trade", callback_data: `exit:100:${position.id}` }]],
      );
      return;
    }

    const wallet = await this.db.getCopyWallet(config.userId, "solana");
    if (!wallet) {
      await this.activity.emit({ userId: config.userId, traderId: config.traderId, type: "copy_skipped", severity: "error", message: `Live copy skipped for ${event.token}: no Solana copy wallet configured`, metadata: { token: event.token, txHash: event.txHash } });
      await this.notify(config.chatId, "⚠️ Live copy skipped: no Solana copy wallet is configured.");
      return;
    }

    try {
      await this.activity.emit({
        userId: config.userId,
        traderId: config.traderId,
        type: "live_buy_started",
        message: `Live buy started for ${event.token}`,
        metadata: { token: event.token, trader: traderName, amountUsd: config.tradeAmountUsd },
      });
      const result = await this.executor.buy({
        signerRef: wallet.signer_ref,
        expectedPublicAddress: wallet.public_address,
        token: event.token,
        amountUsd: config.tradeAmountUsd,
        slippageBps: config.slippageBps,
        onProgress: (stage, message, metadata) => this.activity.emit({
          userId: config.userId,
          traderId: config.traderId,
          type: `buy_${stage}`,
          message,
          metadata: { ...metadata, txHash: event.txHash },
        }),
      });
      const position = await this.db.createPosition({
        userId: config.userId, traderId: config.traderId, configId: config.id, copyWalletId: wallet.id,
        chain: "solana", token: event.token, qty: result.tokenQty, costUsd: result.actualUsd,
        entryPrice: result.executionPrice, mode: "live",
      });
      const executionId = await this.db.createExecution({
        userId: config.userId, positionId: position.id, traderId: config.traderId, sourceTxHash: event.txHash,
        chain: "solana", token: event.token, side: "buy", reason: `COPY_${kind.toUpperCase()}`,
        requestedUsd: config.tradeAmountUsd, actualUsd: result.actualUsd, tokenQty: result.tokenQty,
        executionPrice: result.executionPrice, txHash: result.txHash, status: "confirmed",
      });
      const tokenLabel = tokenDisplay(event.token, market);
      await this.activity.emit({
        userId: config.userId,
        traderId: config.traderId,
        positionId: position.id,
        executionId,
        type: "buy_confirmed",
        severity: "success",
        message: `BUY confirmed: $${result.actualUsd.toFixed(2)} ${market.symbol ?? event.token}`,
        metadata: { token: event.token, txHash: result.txHash, amountUsd: result.actualUsd, executionPrice: result.executionPrice },
      });
      await this.notify(config.chatId,
        `🟢 Live buy confirmed\n` +
        `Trader: ${traderName}\n` +
        `Bought: $${result.actualUsd.toFixed(2)} of ${tokenLabel}\n` +
        `Received: ${formatNumber(result.tokenQty, market.symbol)}\n` +
        `Entry price: $${result.executionPrice}\n` +
        `Reason: ${kind === "new_entry" ? "copied new entry" : "copied top-up"}\n` +
        `Tx: ${solscanTx(result.txHash)}`,
        [[{ text: "Sell 50%", callback_data: `exit:50:${position.id}` }, { text: "Sell all", callback_data: `exit:100:${position.id}` }]],
      );
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        const executionId = await this.db.createExecution({
          userId: config.userId, traderId: config.traderId, sourceTxHash: event.txHash,
          chain: "solana", token: event.token, side: "buy", reason: `COPY_${kind.toUpperCase()}`,
          requestedUsd: config.tradeAmountUsd, txHash: error.signature, status: "submitted_unknown",
        });
        await this.activity.emit({
          userId: config.userId,
          traderId: config.traderId,
          executionId,
          type: "buy_status_unknown",
          severity: "warning",
          message: `BUY submitted but confirmation is unknown for ${event.token}`,
          metadata: { token: event.token, txHash: error.signature },
        });
        await this.notify(config.chatId,
          `⚠️ Live buy status unknown\n` +
          `Trader: ${traderName}\n` +
          `Token: ${shortAddress(event.token)}\n` +
          `The transaction was submitted, but confirmation timed out. Do not retry yet; the bot will check chain status.\n` +
          `Tx: ${solscanTx(error.signature)}`,
        );
        return;
      }
      const executionId = await this.db.createExecution({
        userId: config.userId, traderId: config.traderId, sourceTxHash: event.txHash,
        chain: "solana", token: event.token, side: "buy", reason: `COPY_${kind.toUpperCase()}`,
        requestedUsd: config.tradeAmountUsd, status: `failed:${String(error).slice(0, 180)}`,
      });
      await this.activity.emit({
        userId: config.userId,
        traderId: config.traderId,
        executionId,
        type: "buy_failed",
        severity: "error",
        message: `COPY FAILED for ${event.token}: ${String(error).slice(0, 180)}`,
        metadata: { token: event.token, sourceTxHash: event.txHash },
      });
      await this.notify(config.chatId,
        `🔴 Live buy failed\n` +
        `Trader: ${traderName}\n` +
        `Token: ${shortAddress(event.token)}\n` +
        `Attempted amount: $${config.tradeAmountUsd.toFixed(2)}\n` +
        `Reason: ${humanError(error)}\n` +
        `Source tx: ${solscanTx(event.txHash)}`,
      );
    }
  }
}

function shortAddress(value: string) {
  return value.length <= 16 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function solscanTx(signature: string) {
  return `https://solscan.io/tx/${signature}`;
}

function tokenDisplay(address: string, market: { symbol?: string; name?: string }) {
  if (market.name && market.symbol) return `${market.name} (${market.symbol})`;
  return market.symbol ?? shortAddress(address);
}

function formatNumber(value: number, symbol?: string) {
  const formatted = value >= 1 ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  return symbol ? `${formatted} ${symbol}` : formatted;
}

function humanError(error: unknown) {
  return String(error).replace(/^Error:\s*/, "").slice(0, 240);
}
