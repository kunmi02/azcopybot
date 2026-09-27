import type { Database } from "../db.js";
import type { DexScreenerPriceService } from "./pricing.js";
import type { SolanaExecutor } from "../execution/solana.js";
import type { Notify } from "./copytrade.js";
import { SubmissionUnknownError } from "../execution/submit.js";
import type { ActivityService } from "./activity.js";
import { errorMessage } from "../errors.js";

export class PositionService {
  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly executor: SolanaExecutor,
    private readonly notify: Notify,
    private readonly activity: ActivityService,
  ) {}

  async exit(userId: string, positionId: string, percentage: number, reason: string) {
    if (![25, 50, 75, 100].includes(percentage)) throw new Error("INVALID_EXIT_PERCENTAGE");
    const position = await this.db.getPositionForUser(userId, positionId);
    if (!position || position.status !== "open") throw new Error("POSITION_NOT_OPEN");
    const market = await this.prices.getTokenMarket(position.token);
    if (!market) throw new Error("PRICE_UNAVAILABLE");

    const fullQty = Number(position.qty);
    const qty = fullQty * (percentage / 100);
    const expectedUsd = qty * market.priceUsd;

    if (position.mode === "paper") {
      const executionId = await this.db.createExecution({
        userId, positionId, traderId: position.trader_id, chain: position.chain, token: position.token,
        side: "sell", reason, actualUsd: expectedUsd, tokenQty: qty, executionPrice: market.priceUsd, status: "paper",
      });
      if (percentage === 100) await this.db.closePosition(positionId);
      else await this.db.pool.query(`UPDATE positions SET qty=qty-$2,cost_usd=cost_usd*(1-$3::double precision) WHERE id=$1`, [positionId, qty, percentage / 100]);
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        executionId,
        type: "paper_sell_created",
        severity: "success",
        message: `Paper exit: ${percentage}% of ${market.symbol ?? position.token}`,
        metadata: { token: position.token, percentage, expectedUsd, reason },
      });
      await this.notify(position.telegram_chat_id, `🟡 PAPER EXIT\n${percentage}% of ${market.symbol ?? position.token}\nValue: $${expectedUsd.toFixed(2)}\nReason: ${reason}`);
      return;
    }

    if (!position.signer_ref || !position.copy_wallet_address) throw new Error("COPY_WALLET_NOT_CONFIGURED");
    try {
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        type: "live_sell_started",
        severity: "warning",
        message: `Live sell started: ${percentage}% of ${market.symbol ?? position.token}`,
        metadata: { token: position.token, percentage, expectedUsd, reason },
      });
      const result = await this.executor.sell({
        signerRef: position.signer_ref,
        expectedPublicAddress: position.copy_wallet_address,
        token: position.token,
        tokenQty: qty,
        slippageBps: Number(position.slippage_bps ?? 300),
        expectedUsd,
        onProgress: (stage, message, metadata) => this.activity.emit({
          userId,
          traderId: position.trader_id,
          positionId,
          type: `sell_${stage}`,
          message,
          metadata: { ...metadata, reason },
        }),
      });
      const executionId = await this.db.createExecution({
        userId, positionId, traderId: position.trader_id, chain: position.chain, token: position.token,
        side: "sell", reason, actualUsd: result.actualUsd, tokenQty: qty, executionPrice: result.executionPrice,
        txHash: result.txHash, status: "confirmed",
      });
      if (percentage === 100) await this.db.closePosition(positionId);
      else await this.db.pool.query(`UPDATE positions SET qty=qty-$2,cost_usd=cost_usd*(1-$3::double precision) WHERE id=$1`, [positionId, qty, percentage / 100]);
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        executionId,
        type: "sell_confirmed",
        severity: "success",
        message: `SELL confirmed: ${percentage}% of ${market.symbol ?? position.token}`,
        metadata: { token: position.token, percentage, actualUsd: result.actualUsd, txHash: result.txHash, reason },
      });
      await this.notify(position.telegram_chat_id, `🔴 EXIT EXECUTED\n${percentage}% sold\nReceived: $${result.actualUsd.toFixed(2)}\nReason: ${reason}\nTX: ${result.txHash}`);
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        await this.db.setPositionStatus(positionId, "closing");
        const executionId = await this.db.createExecution({
          userId, positionId, traderId: position.trader_id, chain: position.chain, token: position.token,
          side: "sell", reason, tokenQty: qty, txHash: error.signature, status: "submitted_unknown",
        });
        await this.activity.emit({
          userId,
          traderId: position.trader_id,
          positionId,
          executionId,
          type: "sell_status_unknown",
          severity: "error",
          message: `EXIT status unknown for ${market.symbol ?? position.token}. Checking chain; do not retry yet.`,
          metadata: { token: position.token, percentage, txHash: error.signature, reason },
        });
        await this.notify(position.telegram_chat_id, `⚠️ EXIT SUBMITTED — CONFIRMATION UNKNOWN\nTX: ${error.signature}\nThe position is locked from another exit until this is reconciled. Do not retry manually.`);
        return;
      }
      const failureReason = errorMessage(error, 500);
      const executionId = await this.db.createExecution({
        userId, positionId, traderId: position.trader_id, chain: position.chain, token: position.token,
        side: "sell", reason, tokenQty: qty, status: `failed:${failureReason.slice(0, 180)}`,
      });
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        executionId,
        type: "sell_failed",
        severity: "error",
        message: `EXIT FAILED for ${market.symbol ?? position.token}: ${failureReason.slice(0, 180)}`,
        metadata: { token: position.token, percentage, reason, error: failureReason },
      });
      await this.notify(
        position.telegram_chat_id,
        `🚨 EXIT FAILED — POSITION STILL OPEN\n${market.symbol ?? position.token}\nReason: ${failureReason}\nUse the dashboard to retry or inspect before submitting again.`,
        [[{ text: "Retry sell", callback_data: `retry_execution:${executionId}` }]],
      );
      throw error;
    }
  }

  async evaluateOpenPositions() {
    const positions = await this.db.listOpenPositions();
    for (const p of positions) {
      try {
        const market = await this.prices.getTokenMarket(p.token);
        if (!market) continue;
        await this.db.updatePositionHigh(p.id, market.priceUsd);
        const entry = Number(p.avg_entry_price);
        const pnlPct = ((market.priceUsd - entry) / entry) * 100;
        const heldSeconds = (Date.now() - new Date(p.opened_at).getTime()) / 1000;

        if (p.take_profit_pct != null && pnlPct >= Number(p.take_profit_pct)) {
          await this.exit(p.user_id, p.id, 100, "TAKE_PROFIT");
        } else if (p.stop_loss_pct != null && pnlPct <= -Number(p.stop_loss_pct)) {
          await this.exit(p.user_id, p.id, 100, "STOP_LOSS");
        } else if (p.max_hold_seconds != null && heldSeconds >= Number(p.max_hold_seconds)) {
          await this.exit(p.user_id, p.id, 100, "MAX_HOLD");
        }
      } catch (error) {
        console.error("position_evaluation_failed", p.id, error);
      }
    }
  }
}
