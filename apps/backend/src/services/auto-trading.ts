import type { Database } from "../db.js";
import type { DexScreenerPriceService } from "./pricing.js";
import type { SolanaExecutor } from "../execution/solana.js";
import type { ActivityService } from "./activity.js";
import type { Notify } from "./copytrade.js";
import { SubmissionUnknownError } from "../execution/submit.js";
import { errorMessage } from "../errors.js";

const AUTO_SLIPPAGE_BPS = 300;

export class AutoTradingService {
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly executor: SolanaExecutor,
    private readonly notify: Notify,
    private readonly activity: ActivityService,
  ) {}

  async runOnce() {
    if (this.running) return { skipped: "already_running" };
    this.running = true;
    try {
      const configs = await this.db.listEnabledAutoTradingConfigs();
      const results: Array<Record<string, unknown>> = [];
      for (const config of configs) {
        results.push(await this.runForConfig(config));
      }
      return { configs: configs.length, results };
    } finally {
      this.running = false;
    }
  }

  private async runForConfig(config: any) {
    const userId = String(config.user_id);
    if (config.paused) return { userId, skipped: "user_paused" };
    if (!config.copy_wallet_id || !config.public_address || !config.signer_ref) {
      await this.activity.emit({
        userId,
        type: "auto_trade_skipped",
        severity: "warning",
        message: "Autonomous trade skipped: copy wallet is not configured",
        metadata: { reason: "copy_wallet_missing" },
      });
      return { userId, skipped: "copy_wallet_missing" };
    }

    const openCount = await this.db.countOpenAutoPositions(userId);
    const maxOpen = Number(config.max_open_positions ?? 1);
    if (openCount >= maxOpen) return { userId, skipped: "max_open_positions", openCount, maxOpen };

    const dailyBuys = await this.db.countDailyAutoBuys(userId);
    const maxDaily = Number(config.max_daily_buys ?? 3);
    if (dailyBuys >= maxDaily) return { userId, skipped: "max_daily_buys", dailyBuys, maxDaily };

    const dailyPnl = await this.db.autoDailyRealizedPnlUsd(userId);
    const lossLimit = Number(config.daily_loss_limit_usd ?? 5);
    if (dailyPnl <= -lossLimit) return { userId, skipped: "daily_loss_limit", dailyPnl, lossLimit };

    const remainingSlots = Math.max(0, maxOpen - openCount, maxDaily - dailyBuys);
    if (remainingSlots <= 0) return { userId, skipped: "no_slots" };

    const candidates = await this.db.listAutoTradeCandidates(userId, config, Math.min(remainingSlots, 3));
    let attempted = 0;
    for (const candidate of candidates) {
      if (attempted >= remainingSlots) break;
      const ok = await this.tryBuyCandidate(config, candidate);
      if (ok) attempted += 1;
    }
    return { userId, candidates: candidates.length, attempted };
  }

  private async tryBuyCandidate(config: any, candidate: any) {
    const userId = String(config.user_id);
    const token = String(candidate.token_mint);
    const signal = await this.db.tryStartAutoTradeSignal({
      userId,
      chain: "solana",
      token,
      signalType: "WINNING_TOKEN_DISCOVERY",
      signalSource: candidate.source_provider ?? "discovery",
      signalScore: Number(candidate.peak_multiple ?? 0),
      metadata: {
        winningTokenId: candidate.id,
        symbol: candidate.metadata?.symbol ?? null,
        name: candidate.metadata?.name ?? null,
        peakMultiple: candidate.peak_multiple,
        liquidityUsd: candidate.liquidity_usd,
        marketCapUsd: candidate.market_cap_usd,
        earlyBuyerCount: candidate.early_buyer_count,
      },
    });
    if (!signal) return false;

    const market = await this.prices.getTokenMarket(token).catch(() => null);
    if (!market || market.priceUsd <= 0) {
      await this.db.updateAutoTradeSignal(signal.id, { status: "skipped", metadata: { reason: "price_unavailable" } });
      await this.activity.emit({
        userId,
        type: "auto_trade_skipped",
        severity: "warning",
        message: `Autonomous buy skipped for ${shortAddress(token)}: price unavailable`,
        metadata: { token, reason: "price_unavailable" },
      });
      return false;
    }
    if (market.liquidityUsd < Number(config.min_liquidity_usd ?? 0)) {
      await this.db.updateAutoTradeSignal(signal.id, { status: "skipped", metadata: { reason: "liquidity_dropped", liquidityUsd: market.liquidityUsd } });
      return false;
    }

    const amountUsd = Number(config.trade_amount_usd ?? 1);
    await this.activity.emit({
      userId,
      type: "auto_buy_started",
      message: `Autonomous buy started for ${market.symbol ?? shortAddress(token)}`,
      metadata: { token, amountUsd, signalId: signal.id, source: "winning_token_discovery" },
    });

    try {
      const result = await this.executor.buy({
        signerRef: config.signer_ref,
        expectedPublicAddress: config.public_address,
        token,
        amountUsd,
        slippageBps: AUTO_SLIPPAGE_BPS,
        onProgress: (stage, message, metadata) =>
          this.activity.emit({
            userId,
            type: `auto_buy_${stage}`,
            message,
            metadata: { ...metadata, token, signalId: signal.id },
          }),
      });
      const position = await this.db.createPosition({
        userId,
        traderId: null,
        configId: null,
        copyWalletId: config.copy_wallet_id,
        chain: "solana",
        token,
        qty: result.tokenQty,
        costUsd: result.actualUsd,
        entryPrice: result.executionPrice,
        mode: "live",
        sourceType: "auto",
        sourceLabel: "Autonomous discovery",
        sourceMetadata: {
          signalId: signal.id,
          winningTokenId: candidate.id,
          symbol: market.symbol ?? null,
          name: market.name ?? null,
          source: "winning_token_discovery",
        },
      });
      const executionId = await this.db.createExecution({
        userId,
        positionId: position.id,
        traderId: null,
        chain: "solana",
        token,
        side: "buy",
        reason: "AUTO_DISCOVERY_ENTRY",
        requestedUsd: amountUsd,
        actualUsd: result.actualUsd,
        tokenQty: result.tokenQty,
        executionPrice: result.executionPrice,
        txHash: result.txHash,
        status: "confirmed",
      });
      await this.db.updateAutoTradeSignal(signal.id, {
        status: "confirmed",
        positionId: position.id,
        executionId,
        metadata: { txHash: result.txHash, actualUsd: result.actualUsd, tokenQty: result.tokenQty },
      });
      await this.activity.emit({
        userId,
        positionId: position.id,
        executionId,
        type: "auto_buy_confirmed",
        severity: "success",
        message: `AUTO BUY confirmed: $${result.actualUsd.toFixed(2)} ${market.symbol ?? shortAddress(token)}`,
        metadata: { token, txHash: result.txHash, amountUsd: result.actualUsd, signalId: signal.id },
      });
      await this.notify(
        config.telegram_chat_id,
        `🤖 Autonomous buy confirmed\n` +
          `Bought: $${result.actualUsd.toFixed(2)} of ${tokenDisplay(token, market)}\n` +
          `Received: ${formatNumber(result.tokenQty, market.symbol)}\n` +
          `Entry price: $${result.executionPrice}\n` +
          `Reason: discovery token passed auto filters\n` +
          `TP: ${config.take_profit_pct ?? "off"}% · SL: ${config.stop_loss_pct ?? "off"}% · Max hold: ${formatHold(config.max_hold_seconds)}\n` +
          `Tx: ${solscanTx(result.txHash)}`,
        [[{ text: "Sell 50%", callback_data: `exit:50:${position.id}` }, { text: "Sell all", callback_data: `exit:100:${position.id}` }]],
      );
      return true;
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        const executionId = await this.db.createExecution({
          userId,
          traderId: null,
          chain: "solana",
          token,
          side: "buy",
          reason: "AUTO_DISCOVERY_ENTRY",
          requestedUsd: amountUsd,
          txHash: error.signature,
          status: "submitted_unknown",
        });
        await this.db.updateAutoTradeSignal(signal.id, { status: "submitted_unknown", executionId, metadata: { txHash: error.signature } });
        await this.activity.emit({
          userId,
          executionId,
          type: "auto_buy_status_unknown",
          severity: "warning",
          message: `AUTO BUY submitted but confirmation is unknown for ${shortAddress(token)}`,
          metadata: { token, txHash: error.signature, signalId: signal.id },
        });
        await this.notify(
          config.telegram_chat_id,
          `⚠️ Autonomous buy status unknown\nToken: ${shortAddress(token)}\nThe transaction was submitted, but confirmation timed out. Do not retry yet.\nTx: ${solscanTx(error.signature)}`,
        );
        return true;
      }
      const failureReason = errorMessage(error, 500);
      const executionId = await this.db.createExecution({
        userId,
        traderId: null,
        chain: "solana",
        token,
        side: "buy",
        reason: "AUTO_DISCOVERY_ENTRY",
        requestedUsd: amountUsd,
        status: `failed:${failureReason.slice(0, 180)}`,
      });
      await this.db.updateAutoTradeSignal(signal.id, { status: "failed", executionId, metadata: { error: failureReason } });
      await this.activity.emit({
        userId,
        executionId,
        type: "auto_buy_failed",
        severity: "error",
        message: `AUTO BUY failed for ${shortAddress(token)}: ${failureReason.slice(0, 180)}`,
        metadata: { token, error: failureReason, signalId: signal.id },
      });
      await this.notify(
        config.telegram_chat_id,
        `🔴 Autonomous buy failed\nToken: ${shortAddress(token)}\nAttempted amount: $${amountUsd.toFixed(2)}\nReason: ${failureReason}`,
        [[{ text: "Retry buy", callback_data: `retry_execution:${executionId}` }]],
      );
      return false;
    }
  }
}

function shortAddress(value: string) {
  return value.length <= 16 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function tokenDisplay(address: string, market: { symbol?: string; name?: string }) {
  if (market.name && market.symbol) return `${market.name} (${market.symbol})`;
  return market.symbol ?? shortAddress(address);
}

function formatNumber(value: number, symbol?: string) {
  const formatted = value >= 1
    ? value.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  return symbol ? `${formatted} ${symbol}` : formatted;
}

function solscanTx(signature: string) {
  return `https://solscan.io/tx/${signature}`;
}

function formatHold(value: unknown) {
  if (value == null) return "off";
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "off";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
