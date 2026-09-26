import type { Database } from "../db.js";
import type { DexScreenerPriceService } from "./pricing.js";
import type { SolanaExecutor } from "../execution/solana.js";
import type { Notify } from "./copytrade.js";
import { SubmissionUnknownError } from "../execution/submit.js";

export class PositionService {
  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly executor: SolanaExecutor,
    private readonly notify: Notify,
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
      await this.db.createExecution({
        userId, positionId, traderId: position.trader_id, chain: position.chain, token: position.token,
        side: "sell", reason, actualUsd: expectedUsd, tokenQty: qty, executionPrice: market.priceUsd, status: "paper",
      });
      if (percentage === 100) await this.db.closePosition(positionId);
      else await this.db.pool.query(`UPDATE positions SET qty=qty-$2,cost_usd=cost_usd*(1-$3::double precision) WHERE id=$1`, [positionId, qty, percentage / 100]);
      await this.notify(position.telegram_chat_id, `🟡 PAPER EXIT\n${percentage}% of ${market.symbol ?? position.token}\nValue: $${expectedUsd.toFixed(2)}\nReason: ${reason}`);
      return;
    }

    if (!position.signer_ref || !position.copy_wallet_address) throw new Error("COPY_WALLET_NOT_CONFIGURED");
    try {
      const result = await this.executor.sell({
        signerRef: position.signer_ref,
        expectedPublicAddress: position.copy_wallet_address,
        token: position.token,
        tokenQty: qty,
        slippageBps: Number(position.slippage_bps ?? 300),
        expectedUsd,
      });
      await this.db.createExecution({
        userId, positionId, traderId: position.trader_id, chain: position.chain, token: position.token,
        side: "sell", reason, actualUsd: result.actualUsd, tokenQty: qty, executionPrice: result.executionPrice,
        txHash: result.txHash, status: "confirmed",
      });
      if (percentage === 100) await this.db.closePosition(positionId);
      else await this.db.pool.query(`UPDATE positions SET qty=qty-$2,cost_usd=cost_usd*(1-$3::double precision) WHERE id=$1`, [positionId, qty, percentage / 100]);
      await this.notify(position.telegram_chat_id, `🔴 EXIT EXECUTED\n${percentage}% sold\nReceived: $${result.actualUsd.toFixed(2)}\nReason: ${reason}\nTX: ${result.txHash}`);
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        await this.db.setPositionStatus(positionId, "closing");
        await this.db.createExecution({
          userId, positionId, traderId: position.trader_id, chain: position.chain, token: position.token,
          side: "sell", reason, tokenQty: qty, txHash: error.signature, status: "submitted_unknown",
        });
        await this.notify(position.telegram_chat_id, `⚠️ EXIT SUBMITTED — CONFIRMATION UNKNOWN\nTX: ${error.signature}\nThe position is locked from another exit until this is reconciled. Do not retry manually.`);
        return;
      }
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
