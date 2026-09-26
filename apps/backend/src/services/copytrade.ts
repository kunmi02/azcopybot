import type { Database } from "../db.js";
import type { CopyConfig, EntryKind, TradeEvent } from "../types.js";
import type { DexScreenerPriceService } from "./pricing.js";
import type { SolanaExecutor } from "../execution/solana.js";
import { SubmissionUnknownError } from "../execution/submit.js";

export type Notify = (chatId: string, text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>) => Promise<void>;

export class CopyTradeService {
  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly executor: SolanaExecutor,
    private readonly notify: Notify,
  ) {}

  async onEntry(config: CopyConfig & { chatId: string; traderHandle: string | null; traderName: string; traderId: string }, event: TradeEvent, kind: EntryKind) {
    if (await this.db.isUserPaused(config.userId)) return;
    if (kind === "new_entry" && !config.copyNewEntries) return;
    if (kind === "top_up" && !config.copyTopups) return;
    if (event.chain !== "solana") return;

    const market = await this.prices.getTokenMarket(event.token);
    if (!market || market.priceUsd <= 0) {
      await this.notify(config.chatId, `⚠️ ${config.traderHandle ?? config.traderName}: entry detected but no reliable price was available for ${event.token}. Skipped.`);
      return;
    }

    if (config.dryRun) {
      const qty = config.tradeAmountUsd / market.priceUsd;
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
      await this.db.createExecution({
        userId: config.userId, positionId: position.id, traderId: config.traderId, sourceTxHash: event.txHash,
        chain: event.chain, token: event.token, side: "buy", reason: `COPY_${kind.toUpperCase()}`,
        requestedUsd: config.tradeAmountUsd, actualUsd: config.tradeAmountUsd, tokenQty: qty,
        executionPrice: market.priceUsd, status: "paper",
      });
      await this.notify(config.chatId,
        `🟡 PAPER ENTRY\n${config.traderHandle ? `@${config.traderHandle}` : config.traderName}\nToken: ${market.symbol ?? event.token}\nKind: ${kind}\nWould buy: $${config.tradeAmountUsd.toFixed(2)}\nEntry: $${market.priceUsd}\nTP: ${config.takeProfitPct ?? "off"}% · SL: ${config.stopLossPct ?? "off"}%`,
        [[{ text: "View position", callback_data: `position:${position.id}` }, { text: "Exit paper trade", callback_data: `exit:100:${position.id}` }]],
      );
      return;
    }

    const wallet = await this.db.getCopyWallet(config.userId, "solana");
    if (!wallet) {
      await this.notify(config.chatId, "⚠️ Live copy skipped: no Solana copy wallet is configured.");
      return;
    }

    try {
      const result = await this.executor.buy({
        signerRef: wallet.signer_ref,
        expectedPublicAddress: wallet.public_address,
        token: event.token,
        amountUsd: config.tradeAmountUsd,
        slippageBps: config.slippageBps,
      });
      const position = await this.db.createPosition({
        userId: config.userId, traderId: config.traderId, configId: config.id, copyWalletId: wallet.id,
        chain: "solana", token: event.token, qty: result.tokenQty, costUsd: result.actualUsd,
        entryPrice: result.executionPrice, mode: "live",
      });
      await this.db.createExecution({
        userId: config.userId, positionId: position.id, traderId: config.traderId, sourceTxHash: event.txHash,
        chain: "solana", token: event.token, side: "buy", reason: `COPY_${kind.toUpperCase()}`,
        requestedUsd: config.tradeAmountUsd, actualUsd: result.actualUsd, tokenQty: result.tokenQty,
        executionPrice: result.executionPrice, txHash: result.txHash, status: "confirmed",
      });
      await this.notify(config.chatId,
        `🟢 COPY EXECUTED\n${config.traderHandle ? `@${config.traderHandle}` : config.traderName}\nToken: ${market.symbol ?? event.token}\nBought: $${result.actualUsd.toFixed(2)}\nEntry: $${result.executionPrice}\nTX: ${result.txHash}`,
        [[{ text: "Sell 50%", callback_data: `exit:50:${position.id}` }, { text: "Sell all", callback_data: `exit:100:${position.id}` }]],
      );
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        await this.db.createExecution({
          userId: config.userId, traderId: config.traderId, sourceTxHash: event.txHash,
          chain: "solana", token: event.token, side: "buy", reason: `COPY_${kind.toUpperCase()}`,
          requestedUsd: config.tradeAmountUsd, txHash: error.signature, status: "submitted_unknown",
        });
        await this.notify(config.chatId, `⚠️ COPY SUBMITTED — CONFIRMATION UNKNOWN\nTX: ${error.signature}\nDo not retry this trade manually until the transaction is checked on-chain.`);
        return;
      }
      await this.db.createExecution({
        userId: config.userId, traderId: config.traderId, sourceTxHash: event.txHash,
        chain: "solana", token: event.token, side: "buy", reason: `COPY_${kind.toUpperCase()}`,
        requestedUsd: config.tradeAmountUsd, status: `failed:${String(error).slice(0, 180)}`,
      });
      await this.notify(config.chatId, `🔴 COPY FAILED\n${config.traderHandle ?? config.traderName}\nToken: ${event.token}\n${String(error)}`);
    }
  }
}
