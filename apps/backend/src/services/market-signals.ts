import type { Database } from "../db.js";
import type { DiscoveryToken, DexScreenerPriceService } from "./pricing.js";
import type { EarlyBuyerSource } from "../sources/helius.js";
import type { SolanaRpc } from "../chains/solana/rpc.js";

const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOLANA_WSOL = "So11111111111111111111111111111111111111112";
const QUOTES = [SOLANA_USDC, SOLANA_USDT, SOLANA_WSOL];

export type MarketSignalScanOptions = {
  maxTokens?: number;
  deepCheckTokens?: number;
  minLiquidityUsd?: number;
  minVolumeH1Usd?: number;
  minTxnsH1?: number;
};

export class MarketSignalService {
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly earlyBuyers: EarlyBuyerSource,
    private readonly rpc: SolanaRpc,
  ) {}

  async scan(options: MarketSignalScanOptions = {}) {
    if (this.running) return { skipped: "already_running" };
    this.running = true;
    try {
      const maxTokens = Math.max(1, Math.min(50, Number(options.maxTokens ?? 20)));
      const deepCheckTokens = Math.max(0, Math.min(maxTokens, Number(options.deepCheckTokens ?? 10)));
      const discovered = await this.prices.discoverSolanaTokens();
      const candidates = discovered
        .map((token) => ({ token, baseScore: baseMarketScore(token, options) }))
        .filter((item) => item.token.liquidityUsd >= Number(options.minLiquidityUsd ?? 5_000))
        .filter((item) => item.token.volumeH1Usd >= Number(options.minVolumeH1Usd ?? 1_000) || item.token.volumeH6Usd >= Number(options.minVolumeH1Usd ?? 1_000) * 2)
        .filter((item) => item.token.txnsH1 >= Number(options.minTxnsH1 ?? 10) || item.token.txnsH6 >= Number(options.minTxnsH1 ?? 10) * 3)
        .sort((a, b) => b.baseScore - a.baseScore)
        .slice(0, maxTokens);

      const snapshots: any[] = [];
      for (let index = 0; index < candidates.length; index++) {
        const deep = index < deepCheckTokens;
        const report = await this.scoreToken(candidates[index].token, deep);
        const row = await this.db.insertMarketSignalSnapshot(report);
        snapshots.push(publicMarketSignal(row));
      }
      return {
        ok: true,
        scanned: discovered.length,
        considered: candidates.length,
        deepChecked: Math.min(deepCheckTokens, candidates.length),
        saved: snapshots.length,
        buyWatch: snapshots.filter((s) => isBuyWatch(s.recommendation)).length,
        avoid: snapshots.filter((s) => isAvoid(s.recommendation)).length,
      };
    } finally {
      this.running = false;
    }
  }

  async feed(limit = 30) {
    const [rows, stats] = await Promise.all([
      this.db.listMarketSignalFeed(limit),
      this.db.marketSignalStats(),
    ]);
    const signals = rows.map(publicMarketSignal);
    return {
      buyWatchlist: signals.filter((signal) => isBuyWatch(signal.recommendation)).slice(0, 10),
      avoidList: signals.filter((signal) => isAvoid(signal.recommendation)).slice(0, 10),
      all: signals,
      stats: {
        snapshotCount: Number(stats?.snapshot_count ?? 0),
        tokenCount: Number(stats?.token_count ?? 0),
        lastScanAt: stats?.last_scan_at ?? null,
      },
    };
  }

  private async scoreToken(token: DiscoveryToken, deep: boolean) {
    const buyReasons: string[] = [];
    const riskReasons: string[] = [];
    const avoidReasons: string[] = [];
    const entryPlan: string[] = [];
    const exitPlan: string[] = [];
    const quality: Record<string, unknown> = { deepChecked: deep };

    const ageMinutes = token.pairCreatedAt ? (Date.now() - token.pairCreatedAt.getTime()) / 60_000 : null;
    const marketCap = token.marketCapUsd ?? token.fdvUsd ?? null;
    let score = baseMarketScore(token, {});

    if (token.liquidityUsd >= 25_000) buyReasons.push(`Liquidity is healthy at $${formatCompact(token.liquidityUsd)}.`);
    else if (token.liquidityUsd < 10_000) avoidReasons.push(`Liquidity is thin at $${formatCompact(token.liquidityUsd)}.`);

    if (token.volumeH1Usd >= 5_000) buyReasons.push(`1h volume is active at $${formatCompact(token.volumeH1Usd)}.`);
    if (token.txnsH1 >= 25) buyReasons.push(`${token.txnsH1} transactions in the last hour.`);
    if (token.priceChangeM5Pct > 120) riskReasons.push(`5m move is already hot at ${token.priceChangeM5Pct.toFixed(0)}%; avoid chasing.`);
    if (token.priceChangeH1Pct < -35) avoidReasons.push(`1h momentum is weak (${token.priceChangeH1Pct.toFixed(0)}%).`);
    if (marketCap != null && marketCap > 250_000) riskReasons.push(`Market cap is already $${formatCompact(marketCap)}; upside may be lower.`);
    if (ageMinutes != null && ageMinutes < 5) riskReasons.push("Pair is very new; wait for a few more candles.");

    if (deep) {
      const [buyerQuality, holderQuality] = await Promise.all([
        this.earlyBuyerQuality(token.tokenAddress).catch((error) => ({ error: errorMessage(error) })),
        this.holderQuality(token.tokenAddress).catch((error) => ({ error: errorMessage(error) })),
      ]);
      quality.helius = buyerQuality;
      quality.holders = holderQuality;

      if ("uniqueBuyers" in buyerQuality) {
        const uniqueBuyers = Number(buyerQuality.uniqueBuyers ?? 0);
        const knownGood = Number(buyerQuality.knownGoodWallets ?? 0);
        const suspiciousFeePayers = Number(buyerQuality.suspiciousFeePayerSharePct ?? 0);
        if (uniqueBuyers >= 10) {
          score += 8;
          buyReasons.push(`${uniqueBuyers} unique early buyers found by Helius.`);
        } else if (uniqueBuyers < 4) {
          score -= 14;
          avoidReasons.push("Too few unique early buyers returned by Helius.");
        }
        if (knownGood > 0) {
          score += Math.min(18, knownGood * 7);
          buyReasons.push(`${knownGood} discovered/candidate wallet${knownGood === 1 ? "" : "s"} touched it early.`);
        }
        if (suspiciousFeePayers >= 55) {
          score -= 22;
          avoidReasons.push("Many early buys share fee-payer/router patterns; possible bundle/fake activity.");
        } else if (suspiciousFeePayers >= 30) {
          score -= 8;
          riskReasons.push("Some early buyers share fee-payer patterns.");
        }
      } else if (buyerQuality.error) {
        riskReasons.push(`Helius buyer quality unavailable: ${String(buyerQuality.error).slice(0, 90)}.`);
      }

      if ("topHolderPct" in holderQuality) {
        const top = Number(holderQuality.topHolderPct ?? 0);
        const top10 = Number(holderQuality.top10HolderPct ?? 0);
        if (top > 12 || top10 > 45) {
          score -= 25;
          avoidReasons.push(`Holder concentration is high: top ${top.toFixed(1)}%, top 10 ${top10.toFixed(1)}%.`);
        } else if (top > 6 || top10 > 30) {
          score -= 8;
          riskReasons.push(`Holder concentration needs caution: top ${top.toFixed(1)}%, top 10 ${top10.toFixed(1)}%.`);
        } else {
          score += 6;
          buyReasons.push(`Holder concentration looks acceptable: top ${top.toFixed(1)}%, top 10 ${top10.toFixed(1)}%.`);
        }
      } else if (holderQuality.error) {
        riskReasons.push(`Holder concentration unavailable: ${String(holderQuality.error).slice(0, 90)}.`);
      }
    }

    score -= avoidReasons.length * 10;
    score -= riskReasons.length * 3;
    score = clamp(score);
    const recommendation = recommendationFor(score, avoidReasons, riskReasons, token);

    if (recommendation === "BUY_WATCH") {
      entryPlan.push("Enter small only while liquidity and 1h volume remain active.");
      entryPlan.push("Avoid market-buying after a sharp green 5m candle; wait for a pullback or consolidation.");
    } else if (recommendation === "WAIT_FOR_PULLBACK") {
      entryPlan.push("Wait for a pullback or a higher-low before entry.");
      entryPlan.push("Do not enter if liquidity falls or 5m momentum turns sharply red.");
    } else {
      entryPlan.push("No entry recommended from the current signal.");
    }

    exitPlan.push("Sell partial size when target profit is reached; do not wait for screenshots/top euphoria.");
    exitPlan.push("Exit if liquidity drops sharply, sell pressure dominates, or the score falls into avoid range on refresh.");
    exitPlan.push("Use the configured stop loss/max hold for any live position.");
    if (token.priceChangeM5Pct > 80) exitPlan.push("If already in, tighten stops because short-term move is extended.");

    return {
      chain: "solana",
      tokenMint: token.tokenAddress,
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      priceUsd: token.priceUsd,
      liquidityUsd: token.liquidityUsd,
      marketCapUsd: marketCap,
      volumeH1Usd: token.volumeH1Usd,
      txnsH1: token.txnsH1,
      ageMinutes,
      priceChangeM5Pct: token.priceChangeM5Pct,
      priceChangeH1Pct: token.priceChangeH1Pct,
      signalScore: score,
      recommendation,
      buyReasons: buyReasons.length ? buyReasons : ["No strong positive signal yet."],
      riskReasons,
      avoidReasons,
      entryPlan,
      exitPlan,
      quality,
      sources: token.sources,
    };
  }

  private async earlyBuyerQuality(mint: string) {
    const buyers = await this.earlyBuyers.findEarlyBuyers({
      mint,
      limit: 40,
      minTradeUsd: 0,
      quoteMints: QUOTES,
    });
    const wallets = buyers.map((buyer) => buyer.wallet);
    const known = await this.db.walletCandidateQuality(wallets);
    const knownByWallet = new Map(known.map((row: any) => [row.wallet_address, row]));
    const feePayers = buyers
      .map((buyer) => buyer.metadata?.feePayer)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const feeCounts = new Map<string, number>();
    for (const feePayer of feePayers) feeCounts.set(feePayer, (feeCounts.get(feePayer) ?? 0) + 1);
    const maxFeePayerShare = buyers.length ? Math.max(0, ...feeCounts.values()) / buyers.length : 0;
    const knownGood = known.filter((row: any) => {
      const score = Number(row.qualification_score ?? row.analysis_metadata?.copy_score ?? row.source_priority ?? 0);
      return score >= 50 && !row.possible_router && !row.possible_deployer;
    });
    return {
      provider: this.earlyBuyers.provider,
      uniqueBuyers: wallets.length,
      knownCandidateWallets: known.length,
      knownGoodWallets: knownGood.length,
      suspiciousFeePayerSharePct: Math.round(maxFeePayerShare * 100),
      sampleBuyers: buyers.slice(0, 8).map((buyer) => ({
        wallet: buyer.wallet,
        rank: buyer.buyerRank,
        knownScore: Number(knownByWallet.get(buyer.wallet)?.qualification_score ?? knownByWallet.get(buyer.wallet)?.source_priority ?? 0),
        signature: buyer.signature,
      })),
    };
  }

  private async holderQuality(mint: string) {
    const [supplyResult, holdersResult] = await Promise.all([
      this.rpc.call<any>("getTokenSupply", [mint, { commitment: "processed" }]),
      this.rpc.call<any>("getTokenLargestAccounts", [mint, { commitment: "processed" }]),
    ]);
    const supply = Number(supplyResult?.value?.uiAmount ?? 0);
    const holders = Array.isArray(holdersResult?.value) ? holdersResult.value : [];
    if (!supply || !holders.length) return { topHolderPct: null, top10HolderPct: null };
    const percentages = holders
      .map((holder: any) => (Number(holder.uiAmount ?? 0) / supply) * 100)
      .filter((value: number) => Number.isFinite(value));
    return {
      supply,
      topHolderPct: percentages[0] ?? 0,
      top10HolderPct: percentages.slice(0, 10).reduce((sum: number, value: number) => sum + value, 0),
      holdersChecked: percentages.length,
    };
  }
}

function baseMarketScore(token: DiscoveryToken, options: MarketSignalScanOptions) {
  const minLiquidity = Number(options.minLiquidityUsd ?? 5_000);
  const minVolume = Number(options.minVolumeH1Usd ?? 1_000);
  const minTxns = Number(options.minTxnsH1 ?? 10);
  const ageMinutes = token.pairCreatedAt ? (Date.now() - token.pairCreatedAt.getTime()) / 60_000 : 60;
  return clamp(
    20 +
      Math.min(18, token.liquidityUsd / Math.max(1, minLiquidity) * 6) +
      Math.min(18, token.volumeH1Usd / Math.max(1, minVolume) * 6) +
      Math.min(16, token.txnsH1 / Math.max(1, minTxns) * 5) +
      momentumScore(token.priceChangeM5Pct, token.priceChangeH1Pct) +
      token.sources.length * 3 -
      (ageMinutes < 3 ? 15 : ageMinutes > 2_880 ? 8 : 0),
  );
}

function momentumScore(m5: number, h1: number) {
  let score = 0;
  if (h1 > 10 && h1 < 180) score += 12;
  if (m5 > -10 && m5 < 80) score += 8;
  if (m5 > 140) score -= 12;
  if (h1 < -30) score -= 12;
  return score;
}

function recommendationFor(score: number, avoidReasons: string[], riskReasons: string[], token: DiscoveryToken) {
  if (avoidReasons.length >= 2 || score < 35) return "AVOID";
  if (token.liquidityUsd < 10_000) return "LOW_LIQUIDITY";
  if (token.priceChangeM5Pct > 160) return "TOO_LATE";
  if (score >= 72 && avoidReasons.length === 0) return "BUY_WATCH";
  if (score >= 55 && riskReasons.length <= 3) return "WAIT_FOR_PULLBACK";
  return "PAPER_ONLY";
}

function isBuyWatch(recommendation: string) {
  return recommendation === "BUY_WATCH" || recommendation === "WAIT_FOR_PULLBACK";
}

function isAvoid(recommendation: string) {
  return ["AVOID", "LOW_LIQUIDITY", "TOO_LATE"].includes(recommendation);
}

function publicMarketSignal(row: any) {
  return {
    id: row.id,
    chain: row.chain,
    token_mint: row.token_mint,
    symbol: row.symbol,
    name: row.name,
    price_usd: row.price_usd == null ? null : Number(row.price_usd),
    liquidity_usd: row.liquidity_usd == null ? null : Number(row.liquidity_usd),
    market_cap_usd: row.market_cap_usd == null ? null : Number(row.market_cap_usd),
    volume_h1_usd: row.volume_h1_usd == null ? null : Number(row.volume_h1_usd),
    txns_h1: row.txns_h1 == null ? null : Number(row.txns_h1),
    age_minutes: row.age_minutes == null ? null : Number(row.age_minutes),
    price_change_m5_pct: row.price_change_m5_pct == null ? null : Number(row.price_change_m5_pct),
    price_change_h1_pct: row.price_change_h1_pct == null ? null : Number(row.price_change_h1_pct),
    signal_score: Number(row.signal_score ?? 0),
    recommendation: row.recommendation,
    buy_reasons: row.buy_reasons ?? [],
    risk_reasons: row.risk_reasons ?? [],
    avoid_reasons: row.avoid_reasons ?? [],
    entry_plan: row.entry_plan ?? [],
    exit_plan: row.exit_plan ?? [],
    quality: row.quality ?? {},
    sources: row.sources ?? [],
    created_at: row.created_at,
  };
}

function formatCompact(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
