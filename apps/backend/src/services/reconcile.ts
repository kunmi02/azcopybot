import type { Database } from "../db.js";
import type { SolanaRpc } from "../chains/solana/rpc.js";
import { SOLANA_USDC } from "../execution/solana.js";
import type { Notify } from "./copytrade.js";

export class SubmissionReconciler {
  constructor(
    private readonly db: Database,
    private readonly rpc: SolanaRpc,
    private readonly notify: Notify,
  ) {}

  async runOnce() {
    const unknown = await this.db.listUnknownExecutions();
    for (const e of unknown) {
      try {
        const status = await this.rpc.signatureStatus(e.tx_hash);
        if (status?.err) {
          await this.db.resolveExecution(e.id, { status: "failed_on_chain" });
          if (e.position_id && e.side === "sell")
            await this.db.setPositionStatus(e.position_id, "open");
          const user = await this.db.getUserById(e.user_id);
          if (user)
            await this.notify(
              user.telegram_chat_id,
              `🔴 Transaction failed on-chain after reconciliation\nTX: ${e.tx_hash}`,
            );
          continue;
        }
        const confirmed =
          status?.confirmationStatus === "confirmed" ||
          status?.confirmationStatus === "finalized";
        if (!confirmed) {
          // Do not retry. After 10 minutes with no known status, treat it as dropped and unlock a sell.
          if (
            Date.now() - new Date(e.created_at).getTime() > 10 * 60_000 &&
            status == null
          ) {
            await this.db.resolveExecution(e.id, { status: "dropped" });
            if (e.position_id && e.side === "sell")
              await this.db.setPositionStatus(e.position_id, "open");
          }
          continue;
        }

        if (!e.public_address) {
          await this.db.resolveExecution(e.id, {
            status: "confirmed_needs_manual_reconcile",
          });
          continue;
        }
        const delta = await this.rpc.tradeDelta(
          e.tx_hash,
          e.public_address,
          e.token,
          SOLANA_USDC,
        );
        if (!delta) continue;
        const tokenDelta =
          Number(delta.tokenDeltaRaw) / 10 ** delta.tokenDecimals;
        const quoteDelta =
          Number(delta.quoteDeltaRaw) / 10 ** (delta.quoteDecimals || 6);

        if (e.side === "buy" && tokenDelta > 0) {
          const config = await this.db.getCopyConfigForUserTrader(
            e.user_id,
            e.trader_id,
          );
          const costUsd =
            quoteDelta < 0 ? -quoteDelta : Number(e.requested_usd ?? 0);
          const price = tokenDelta > 0 ? costUsd / tokenDelta : 0;
          let position: any = null;
          if (e.position_id && e.reason === "PAPER_TO_LIVE") {
            position = await this.db.convertPaperPositionToLive(
              e.position_id,
              e.copy_wallet_id ?? config?.tradingWalletId ?? null,
              tokenDelta,
              costUsd,
              price,
            );
            if (!position) {
              position = await this.db.getPositionForUser(
                e.user_id,
                e.position_id,
              );
            }
          } else {
            if (!config) {
              await this.db.resolveExecution(e.id, {
                status: "confirmed_needs_manual_reconcile",
              });
              continue;
            }
            position = await this.db.createPosition({
              userId: e.user_id,
              traderId: e.trader_id,
              configId: config.id,
              copyWalletId: e.copy_wallet_id ?? config.tradingWalletId,
              chain: e.chain,
              token: e.token,
              qty: tokenDelta,
              costUsd,
              entryPrice: price,
              mode: "live",
            });
          }
          if (!position) {
            await this.db.resolveExecution(e.id, {
              status: "confirmed_needs_manual_reconcile",
            });
            continue;
          }
          await this.db.resolveExecution(e.id, {
            status: "confirmed",
            actualUsd: costUsd,
            tokenQty: tokenDelta,
            executionPrice: price,
            positionId: position.id,
          });
          const user = await this.db.getUserById(e.user_id);
          if (user)
            await this.notify(
              user.telegram_chat_id,
              `✅ Previously unknown BUY confirmed and reconciled
TX: ${e.tx_hash}`,
            );
        } else if (e.side === "sell" && e.position_id) {
          const receivedUsd =
            quoteDelta > 0 ? quoteDelta : Number(e.actual_usd ?? 0);
          const position = await this.db.getPositionForUser(
            e.user_id,
            e.position_id,
          );
          if (position) {
            const soldQty = Math.abs(tokenDelta) || Number(e.token_qty ?? 0);
            const currentQty = Number(position.qty);
            if (soldQty >= currentQty * 0.999)
              await this.db.closePosition(e.position_id);
            else {
              const fraction = Math.min(1, soldQty / currentQty);
              await this.db.pool.query(
                `UPDATE positions SET status='open',qty=GREATEST(qty-$2,0),cost_usd=cost_usd*(1-$3::double precision) WHERE id=$1`,
                [e.position_id, soldQty, fraction],
              );
            }
            const executionPrice = soldQty > 0 ? receivedUsd / soldQty : null;
            await this.db.resolveExecution(e.id, {
              status: "confirmed",
              actualUsd: receivedUsd,
              tokenQty: soldQty,
              executionPrice,
            });
            const user = await this.db.getUserById(e.user_id);
            if (user)
              await this.notify(
                user.telegram_chat_id,
                `✅ Previously unknown SELL confirmed and reconciled\nTX: ${e.tx_hash}`,
              );
          }
        } else {
          await this.db.resolveExecution(e.id, {
            status: "confirmed_needs_manual_reconcile",
          });
        }
      } catch (error) {
        console.error("submission_reconcile_failed", e.id, error);
      }
    }
  }
}
