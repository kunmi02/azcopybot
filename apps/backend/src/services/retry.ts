import type { Database } from "../db.js";
import type { SolanaExecutor } from "../execution/solana.js";
import { SubmissionUnknownError } from "../execution/submit.js";
import type { DexScreenerPriceService } from "./pricing.js";
import type { ActivityService } from "./activity.js";
import type { Notify } from "./copytrade.js";
import type { PositionService } from "./positions.js";
import { errorMessage } from "../errors.js";

export class RetryExecutionService {
  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly executor: SolanaExecutor,
    private readonly positions: PositionService,
    private readonly notify: Notify,
    private readonly activity: ActivityService,
  ) {}

  async retry(userId: string, executionId: string) {
    const execution = await this.db.getExecutionForUser(userId, executionId);
    if (!execution) throw new Error("EXECUTION_NOT_FOUND");
    if (!String(execution.status).startsWith("failed")) throw new Error("ONLY_FAILED_EXECUTIONS_CAN_BE_RETRIED");
    if (execution.status === "submitted_unknown") throw new Error("UNKNOWN_STATUS_MUST_BE_RECONCILED_NOT_RETRIED");
    if (execution.side === "buy") return this.retryBuy(userId, execution);
    if (execution.side === "sell") return this.retrySell(userId, execution);
    throw new Error("UNSUPPORTED_EXECUTION_SIDE");
  }

  private async retryBuy(userId: string, execution: any) {
    if (execution.chain !== "solana") throw new Error("CHAIN_NOT_ENABLED_IN_V1");
    if (!execution.trader_id) throw new Error("EXECUTION_HAS_NO_TRADER");
    const config = await this.db.getCopyConfigForUserTrader(userId, execution.trader_id);
    if (!config?.enabled) throw new Error("CONFIG_NOT_ACTIVE");
    if (config.dryRun) throw new Error("CONFIG_IS_NOT_LIVE");
    if (await this.db.isUserPaused(userId)) throw new Error("USER_PAUSED_NEW_ENTRIES");
    const wallet = await this.db.getCopyWallet(userId, "solana");
    if (!wallet) throw new Error("COPY_WALLET_NOT_CONFIGURED");
    const user = await this.db.getUserById(userId);
    const market = await this.prices.getTokenMarket(execution.token);
    if (!market || market.priceUsd <= 0) throw new Error("PRICE_UNAVAILABLE");
    const amountUsd = Number(execution.requested_usd ?? config.tradeAmountUsd);
    const traderName = execution.handle ? `@${execution.handle}` : execution.display_name ?? "leader";

    try {
      await this.activity.emit({
        userId,
        traderId: execution.trader_id,
        executionId: execution.id,
        type: "buy_retry_started",
        severity: "warning",
        message: `Retrying failed buy for ${market.symbol ?? execution.token}`,
        metadata: { token: execution.token, amountUsd, originalExecutionId: execution.id },
      });
      const result = await this.executor.buy({
        signerRef: wallet.signer_ref,
        expectedPublicAddress: wallet.public_address,
        token: execution.token,
        amountUsd,
        slippageBps: config.slippageBps,
        onProgress: (stage, message, metadata) => this.activity.emit({
          userId,
          traderId: execution.trader_id,
          type: `buy_retry_${stage}`,
          message,
          metadata: { ...metadata, originalExecutionId: execution.id },
        }),
      });
      const position = await this.db.createPosition({
        userId,
        traderId: execution.trader_id,
        configId: config.id,
        copyWalletId: wallet.id,
        chain: "solana",
        token: execution.token,
        qty: result.tokenQty,
        costUsd: result.actualUsd,
        entryPrice: result.executionPrice,
        mode: "live",
      });
      const retryExecutionId = await this.db.createExecution({
        userId,
        positionId: position.id,
        traderId: execution.trader_id,
        sourceTxHash: execution.source_tx_hash,
        chain: "solana",
        token: execution.token,
        side: "buy",
        reason: `${execution.reason}_RETRY`,
        requestedUsd: amountUsd,
        actualUsd: result.actualUsd,
        tokenQty: result.tokenQty,
        executionPrice: result.executionPrice,
        txHash: result.txHash,
        status: "confirmed",
      });
      await this.activity.emit({
        userId,
        traderId: execution.trader_id,
        positionId: position.id,
        executionId: retryExecutionId,
        type: "buy_retry_confirmed",
        severity: "success",
        message: `Retry BUY confirmed: $${result.actualUsd.toFixed(2)} ${market.symbol ?? execution.token}`,
        metadata: { token: execution.token, txHash: result.txHash, originalExecutionId: execution.id },
      });
      if (user) await this.notify(user.telegram_chat_id,
        `🟢 Retry buy confirmed\n` +
        `Trader: ${traderName}\n` +
        `Bought: $${result.actualUsd.toFixed(2)} of ${market.symbol ?? execution.token}\n` +
        `Tx: https://solscan.io/tx/${result.txHash}`,
        [[{ text: "Sell 50%", callback_data: `exit:50:${position.id}` }, { text: "Sell all", callback_data: `exit:100:${position.id}` }]],
      );
      return { ok: true, executionId: retryExecutionId, positionId: position.id };
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        const retryExecutionId = await this.db.createExecution({
          userId,
          traderId: execution.trader_id,
          sourceTxHash: execution.source_tx_hash,
          chain: "solana",
          token: execution.token,
          side: "buy",
          reason: `${execution.reason}_RETRY`,
          requestedUsd: amountUsd,
          txHash: error.signature,
          status: "submitted_unknown",
        });
        await this.activity.emit({ userId, traderId: execution.trader_id, executionId: retryExecutionId, type: "buy_retry_status_unknown", severity: "warning", message: `Retry BUY submitted but confirmation is unknown for ${execution.token}`, metadata: { token: execution.token, txHash: error.signature, originalExecutionId: execution.id } });
        if (user) await this.notify(user.telegram_chat_id, `⚠️ Retry buy status unknown\nToken: ${execution.token}\nTx: https://solscan.io/tx/${error.signature}\nDo not retry again until reconciliation checks chain status.`);
        return { ok: true, executionId: retryExecutionId, status: "submitted_unknown" };
      }
      const failureReason = errorMessage(error, 500);
      const retryExecutionId = await this.db.createExecution({
        userId,
        traderId: execution.trader_id,
        sourceTxHash: execution.source_tx_hash,
        chain: "solana",
        token: execution.token,
        side: "buy",
        reason: `${execution.reason}_RETRY`,
        requestedUsd: amountUsd,
        status: `failed:${failureReason.slice(0, 180)}`,
      });
      await this.activity.emit({ userId, traderId: execution.trader_id, executionId: retryExecutionId, type: "buy_retry_failed", severity: "error", message: `Retry BUY failed for ${execution.token}: ${failureReason.slice(0, 180)}`, metadata: { token: execution.token, error: failureReason, originalExecutionId: execution.id } });
      if (user) await this.notify(user.telegram_chat_id, `🔴 Retry buy failed\nTrader: ${traderName}\nToken: ${execution.token}\nReason: ${failureReason}`);
      throw error;
    }
  }

  private async retrySell(userId: string, execution: any) {
    if (!execution.position_id) throw new Error("SELL_EXECUTION_HAS_NO_POSITION");
    if (execution.status === "submitted_unknown") throw new Error("UNKNOWN_STATUS_MUST_BE_RECONCILED_NOT_RETRIED");
    const position = await this.db.getPositionForUser(userId, execution.position_id);
    if (!position || position.status !== "open") throw new Error("POSITION_NOT_OPEN");
    const tokenQty = Number(execution.token_qty ?? 0);
    if (!(tokenQty > 0)) throw new Error("SELL_EXECUTION_HAS_NO_TOKEN_QTY");
    const positionQty = Number(position.qty);
    const rawPercentage = (tokenQty / positionQty) * 100;
    const percentage = [25, 50, 75, 100].find((p) => Math.abs(p - rawPercentage) < 0.5);
    if (!percentage) throw new Error("SELL_RETRY_PERCENTAGE_NOT_SUPPORTED");
    await this.activity.emit({ userId, traderId: execution.trader_id, positionId: execution.position_id, executionId: execution.id, type: "sell_retry_started", severity: "warning", message: `Retrying failed sell: ${percentage}% of ${position.token}`, metadata: { token: position.token, percentage, originalExecutionId: execution.id } });
    await this.positions.exit(userId, execution.position_id, percentage, `${execution.reason}_RETRY`);
    return { ok: true, percentage };
  }
}
