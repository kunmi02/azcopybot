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

  async exit(
    userId: string,
    positionId: string,
    percentage: number,
    reason: string,
    options: { bypassValueSanity?: boolean } = {},
  ): Promise<void> {
    if (![25, 50, 75, 100].includes(percentage))
      throw new Error("INVALID_EXIT_PERCENTAGE");
    const position = await this.db.getPositionForUser(userId, positionId);
    if (!position || position.status !== "open")
      throw new Error("POSITION_NOT_OPEN");
    const market = await this.prices.getTokenMarket(position.token);
    if (!market) throw new Error("PRICE_UNAVAILABLE");

    const fullQty = Number(position.qty);
    const qty = fullQty * (percentage / 100);
    const expectedUsd = qty * market.priceUsd;

    if (position.mode === "paper") {
      const executionId = await this.db.createExecution({
        userId,
        positionId,
        traderId: position.trader_id,
        chain: position.chain,
        token: position.token,
        side: "sell",
        reason,
        actualUsd: expectedUsd,
        tokenQty: qty,
        executionPrice: market.priceUsd,
        status: "paper",
      });
      if (percentage === 100) await this.db.closePosition(positionId);
      else
        await this.db.pool.query(
          `UPDATE positions SET qty=qty-$2,cost_usd=cost_usd*(1-$3::double precision) WHERE id=$1`,
          [positionId, qty, percentage / 100],
        );
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
      await this.notify(
        position.telegram_chat_id,
        `🟡 PAPER EXIT\n${percentage}% of ${market.symbol ?? position.token}\nValue: $${expectedUsd.toFixed(2)}\nReason: ${reason}`,
      );
      return;
    }

    if (!position.signer_ref || !position.copy_wallet_address)
      throw new Error("COPY_WALLET_NOT_CONFIGURED");
    try {
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        type: options.bypassValueSanity ? "emergency_sell_started" : "live_sell_started",
        severity: "warning",
        message: `${options.bypassValueSanity ? "Emergency sell" : "Live sell"} started: ${percentage}% of ${market.symbol ?? position.token}`,
        metadata: { token: position.token, percentage, expectedUsd, reason, bypassValueSanity: Boolean(options.bypassValueSanity) },
      });
      const result = await this.executor.sell({
        signerRef: position.signer_ref,
        expectedPublicAddress: position.copy_wallet_address,
        token: position.token,
        tokenQty: qty,
        slippageBps: Number(position.slippage_bps ?? 300),
        expectedUsd,
        bypassValueSanity: Boolean(options.bypassValueSanity),
        onProgress: (stage, message, metadata) =>
          this.activity.emit({
            userId,
            traderId: position.trader_id,
            positionId,
            type: `sell_${stage}`,
            message,
            metadata: { ...metadata, reason },
          }),
      });
      const executionId = await this.db.createExecution({
        userId,
        positionId,
        traderId: position.trader_id,
        chain: position.chain,
        token: position.token,
        side: "sell",
        reason,
        actualUsd: result.actualUsd,
        tokenQty: qty,
        executionPrice: result.executionPrice,
        txHash: result.txHash,
        status: "confirmed",
      });
      if (percentage === 100) await this.db.closePosition(positionId);
      else
        await this.db.pool.query(
          `UPDATE positions SET qty=qty-$2,cost_usd=cost_usd*(1-$3::double precision) WHERE id=$1`,
          [positionId, qty, percentage / 100],
        );
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        executionId,
        type: "sell_confirmed",
        severity: "success",
        message: `${options.bypassValueSanity ? "EMERGENCY SELL" : "SELL"} confirmed: ${percentage}% of ${market.symbol ?? position.token}`,
        metadata: {
          token: position.token,
          percentage,
          actualUsd: result.actualUsd,
          txHash: result.txHash,
          reason,
          bypassValueSanity: Boolean(options.bypassValueSanity),
        },
      });
      await this.notify(
        position.telegram_chat_id,
        `${options.bypassValueSanity ? "🚨 EMERGENCY EXIT EXECUTED" : "🔴 EXIT EXECUTED"}\n${percentage}% sold\nReceived: $${result.actualUsd.toFixed(2)}\nReason: ${reason}\nTX: ${result.txHash}`,
      );
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        await this.db.setPositionStatus(positionId, "closing");
        const executionId = await this.db.createExecution({
          userId,
          positionId,
          traderId: position.trader_id,
          chain: position.chain,
          token: position.token,
          side: "sell",
          reason,
          tokenQty: qty,
          txHash: error.signature,
          status: "submitted_unknown",
        });
        await this.activity.emit({
          userId,
          traderId: position.trader_id,
          positionId,
          executionId,
          type: "sell_status_unknown",
          severity: "error",
          message: `EXIT status unknown for ${market.symbol ?? position.token}. Checking chain; do not retry yet.`,
          metadata: {
            token: position.token,
            percentage,
            txHash: error.signature,
            reason,
          },
        });
        await this.notify(
          position.telegram_chat_id,
          `⚠️ EXIT SUBMITTED — CONFIRMATION UNKNOWN\nTX: ${error.signature}\nThe position is locked from another exit until this is reconciled. Do not retry manually.`,
        );
        return;
      }
      const failureReason = errorMessage(error, 500);
      const executionId = await this.db.createExecution({
        userId,
        positionId,
        traderId: position.trader_id,
        chain: position.chain,
        token: position.token,
        side: "sell",
        reason,
        tokenQty: qty,
        status: `failed:${failureReason.slice(0, 180)}`,
      });
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        executionId,
        type: "sell_failed",
        severity: "error",
        message: `EXIT FAILED for ${market.symbol ?? position.token}: ${failureReason.slice(0, 180)}`,
        metadata: {
          token: position.token,
          percentage,
          reason,
          error: failureReason,
          bypassValueSanity: Boolean(options.bypassValueSanity),
        },
      });

      const failedSellAttempts = await this.db.countFailedSellExecutions(
        positionId,
        position.token,
      );
      const shouldAutoEmergencySell =
        !options.bypassValueSanity &&
        failedSellAttempts >= 2 &&
        failureReason.includes("VALUE_SANITY_CHECK_FAILED");

      if (shouldAutoEmergencySell) {
        await this.activity.emit({
          userId,
          traderId: position.trader_id,
          positionId,
          executionId,
          type: "auto_emergency_sell_triggered",
          severity: "warning",
          message: `Sell failed ${failedSellAttempts} times for ${market.symbol ?? position.token}. Trying emergency sell anyway.`,
          metadata: {
            token: position.token,
            percentage,
            reason,
            failedSellAttempts,
            originalExecutionId: executionId,
          },
        });
        await this.notify(
          position.telegram_chat_id,
          `🚨 EXIT FAILED ${failedSellAttempts} TIMES — TRYING SELL ANYWAY\n${market.symbol ?? position.token}\nReason: ${failureReason}\nCopyBot is now submitting an emergency exit that bypasses the value sanity check.`,
        );
        return this.exit(
          userId,
          positionId,
          percentage,
          `${reason}_AUTO_EMERGENCY`,
          { bypassValueSanity: true },
        );
      }

      await this.notify(
        position.telegram_chat_id,
        `🚨 EXIT FAILED — POSITION STILL OPEN\n${market.symbol ?? position.token}\nReason: ${failureReason}\n${failureReason.includes("VALUE_SANITY_CHECK_FAILED") ? `Failed sell attempts: ${failedSellAttempts}/2 before automatic sell-anyway.` : "Use the dashboard to retry or inspect before submitting again."}`,
        [
          [
            {
              text: "Retry sell",
              callback_data: `retry_execution:${executionId}`,
            },
          ],
        ],
      );
      throw error;
    }
  }

  async convertPaperToLive(userId: string, positionId: string) {
    const position = await this.db.getPositionForUser(userId, positionId);
    if (!position || position.status !== "open")
      throw new Error("POSITION_NOT_OPEN");
    if (position.mode !== "paper")
      throw new Error("ONLY_PAPER_POSITIONS_CAN_BE_CONVERTED");
    if (position.chain !== "solana") throw new Error("CHAIN_NOT_ENABLED_IN_V1");
    const amountUsd = Number(position.cost_usd);
    if (!(amountUsd > 0)) throw new Error("POSITION_COST_UNAVAILABLE");
    const wallet = await this.db.getCopyWallet(userId, "solana");
    if (!wallet) throw new Error("COPY_WALLET_NOT_CONFIGURED");
    const market = await this.prices.getTokenMarket(position.token);
    if (!market) throw new Error("PRICE_UNAVAILABLE");
    const tokenLabel = market.symbol ?? position.token;

    try {
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        type: "paper_to_live_started",
        severity: "warning",
        message: `Converting paper position to live: ${tokenLabel}`,
        metadata: { token: position.token, amountUsd },
      });
      const result = await this.executor.buy({
        signerRef: wallet.signer_ref,
        expectedPublicAddress: wallet.public_address,
        token: position.token,
        amountUsd,
        slippageBps: Number(position.slippage_bps ?? 300),
        onProgress: (stage, message, metadata) =>
          this.activity.emit({
            userId,
            traderId: position.trader_id,
            positionId,
            type: `paper_to_live_${stage}`,
            message,
            metadata: { ...metadata, reason: "PAPER_TO_LIVE" },
          }),
      });
      const livePosition = await this.db.convertPaperPositionToLive(
        positionId,
        wallet.id,
        result.tokenQty,
        result.actualUsd,
        result.executionPrice,
      );
      if (!livePosition) throw new Error("PAPER_POSITION_CONVERSION_FAILED");
      const executionId = await this.db.createExecution({
        userId,
        positionId,
        traderId: position.trader_id,
        chain: "solana",
        token: position.token,
        side: "buy",
        reason: "PAPER_TO_LIVE",
        requestedUsd: amountUsd,
        actualUsd: result.actualUsd,
        tokenQty: result.tokenQty,
        executionPrice: result.executionPrice,
        txHash: result.txHash,
        status: "confirmed",
      });
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        executionId,
        type: "paper_to_live_confirmed",
        severity: "success",
        message: `Paper position converted to LIVE: $${result.actualUsd.toFixed(2)} ${tokenLabel}`,
        metadata: {
          token: position.token,
          txHash: result.txHash,
          amountUsd: result.actualUsd,
          executionPrice: result.executionPrice,
        },
      });
      await this.notify(
        position.telegram_chat_id,
        `🟢 PAPER → LIVE confirmed\n${tokenLabel}\nBought: $${result.actualUsd.toFixed(2)}\nEntry price: $${result.executionPrice}\nTx: ${result.txHash}`,
        [
          [
            { text: "Sell 50%", callback_data: `exit:50:${positionId}` },
            { text: "Sell all", callback_data: `exit:100:${positionId}` },
          ],
        ],
      );
      return { ok: true, positionId, executionId, txHash: result.txHash };
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        const executionId = await this.db.createExecution({
          userId,
          positionId,
          traderId: position.trader_id,
          chain: "solana",
          token: position.token,
          side: "buy",
          reason: "PAPER_TO_LIVE",
          requestedUsd: amountUsd,
          txHash: error.signature,
          status: "submitted_unknown",
        });
        await this.activity.emit({
          userId,
          traderId: position.trader_id,
          positionId,
          executionId,
          type: "paper_to_live_status_unknown",
          severity: "warning",
          message: `Paper → LIVE submitted but confirmation is unknown for ${tokenLabel}`,
          metadata: { token: position.token, txHash: error.signature },
        });
        await this.notify(
          position.telegram_chat_id,
          `⚠️ PAPER → LIVE status unknown\n${tokenLabel}\nTx: ${error.signature}\nDo not retry until reconciliation checks chain status.`,
        );
        return {
          ok: true,
          status: "submitted_unknown",
          executionId,
          txHash: error.signature,
        };
      }
      const failureReason = errorMessage(error, 500);
      const executionId = await this.db.createExecution({
        userId,
        positionId,
        traderId: position.trader_id,
        chain: "solana",
        token: position.token,
        side: "buy",
        reason: "PAPER_TO_LIVE",
        requestedUsd: amountUsd,
        status: `failed:${failureReason.slice(0, 180)}`,
      });
      await this.activity.emit({
        userId,
        traderId: position.trader_id,
        positionId,
        executionId,
        type: "paper_to_live_failed",
        severity: "error",
        message: `PAPER → LIVE failed for ${tokenLabel}: ${failureReason.slice(0, 180)}`,
        metadata: { token: position.token, error: failureReason },
      });
      await this.notify(
        position.telegram_chat_id,
        `🔴 PAPER → LIVE failed\n${tokenLabel}\nAttempted amount: $${amountUsd.toFixed(2)}\nReason: ${failureReason}`,
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
        const heldSeconds =
          (Date.now() - new Date(p.opened_at).getTime()) / 1000;

        const minHoldSeconds =
          p.source_type === "auto" ? Number(p.min_hold_seconds ?? 0) : 0;
        const minimumHoldActive = heldSeconds < minHoldSeconds;

        if (
          p.stop_loss_pct != null &&
          pnlPct <= -Number(p.stop_loss_pct)
        ) {
          await this.exit(p.user_id, p.id, 100, "STOP_LOSS");
        } else if (
          !minimumHoldActive &&
          p.take_profit_pct != null &&
          pnlPct >= Number(p.take_profit_pct)
        ) {
          await this.exit(p.user_id, p.id, 100, "TAKE_PROFIT");
        } else if (
          !minimumHoldActive &&
          p.max_hold_seconds != null &&
          heldSeconds >= Number(p.max_hold_seconds)
        ) {
          await this.exit(p.user_id, p.id, 100, "MAX_HOLD");
        }
      } catch (error) {
        console.error("position_evaluation_failed", p.id, error);
      }
    }
  }
}
