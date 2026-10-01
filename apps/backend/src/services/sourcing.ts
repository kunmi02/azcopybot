import type { Database } from "../db.js";
import type {
  DexScreenerPriceService,
  DiscoveryToken,
} from "./pricing.js";
import type {
  EarlyBuyerSource,
  WalletSwap,
  WalletSwapActivitySource,
} from "../sources/helius.js";
import { PublicKey } from "@solana/web3.js";

const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOLANA_WS0L = "So11111111111111111111111111111111111111112";

export type SourcingScanOptions = {
  maxTokens: number;
  minLiquidityUsd: number;
  minVolumeH1Usd: number;
  minTxnsH1: number;
  minAgeMinutes: number;
  maxAgeHours: number;
  minPeakMultiple: number;
};

export class SourcingService {
  constructor(
    private readonly db: Database,
    private readonly prices: DexScreenerPriceService,
    private readonly earlyBuyers: EarlyBuyerSource & WalletSwapActivitySource,
  ) {}

  async discoverWinningToken(input: {
    mint: string;
    peakMultiple?: number | null;
    maxBuyers?: number;
    minTradeUsd?: number;
  }) {
    const mint = input.mint.trim();
    try {
      new PublicKey(mint);
    } catch {
      throw Object.assign(new Error("INVALID_SOLANA_MINT"), {
        statusCode: 400,
      });
    }
    const market = await this.prices.getTokenMarket(mint).catch(() => null);
    const peakMultiple = input.peakMultiple ?? null;
    const winningToken = await this.db.upsertWinningToken({
      chain: "solana",
      tokenMint: mint,
      peakPriceUsd: market?.priceUsd ?? null,
      peakMultiple,
      liquidityUsd: market?.liquidityUsd ?? null,
      discoveryReason: peakMultiple
        ? `manual_reverse_discovery_${peakMultiple}x`
        : "manual_reverse_discovery",
      sourceProvider: this.earlyBuyers.provider,
      metadata: { symbol: market?.symbol ?? null, name: market?.name ?? null },
    });

    const buyers = await this.earlyBuyers.findEarlyBuyers({
      mint,
      limit: input.maxBuyers ?? 100,
      minTradeUsd: input.minTradeUsd ?? 10,
      quoteMints: [SOLANA_USDC, SOLANA_USDT, SOLANA_WS0L],
    });

    let stored = 0;
    for (const buyer of buyers) {
      if (isObviousNonCandidate(buyer.wallet)) continue;
      await this.db.addTokenEarlyBuyer({
        winningTokenId: winningToken.id,
        walletAddress: buyer.wallet,
        buyerRank: buyer.buyerRank,
        buyTime: buyer.buyTime,
        buyAmountUsd: buyer.buyAmountUsd,
        meaningful: true,
        metadata: {
          ...buyer.metadata,
          signature: buyer.signature,
          tokenAmount: buyer.tokenAmount,
        },
      });
      const candidate = await this.db.upsertWalletCandidate({
        chain: "solana",
        walletAddress: buyer.wallet,
        metadata: { firstSource: "WINNING_TOKEN_EARLY_BUYER" },
      });
      await this.db.addWalletCandidateSource({
        candidateId: candidate.id,
        sourceType: "WINNING_TOKEN_EARLY_BUYER",
        sourceProvider: this.earlyBuyers.provider,
        sourceEntity: mint,
        sourceEventId: `${mint}:${buyer.wallet}`,
        tokenMint: mint,
        observedAt: buyer.buyTime,
        metadata: {
          buyerRank: buyer.buyerRank,
          buyAmountUsd: buyer.buyAmountUsd,
          signature: buyer.signature,
          tokenPeakMultiple: peakMultiple,
          tokenSymbol: market?.symbol ?? null,
        },
      });
      stored += 1;
    }
    await this.db.recalculateWalletSourceStats();
    await this.db.markWinningTokenProcessed(winningToken.id);
    return {
      ok: true,
      token: winningToken,
      provider: this.earlyBuyers.provider,
      buyersFound: buyers.length,
      candidatesStored: stored,
    };
  }

  async scanTrendingTokens(options: SourcingScanOptions) {
    const discovered = await this.prices.discoverSolanaTokens();
    const eligible = discovered
      .map((token) => evaluateDiscoveryToken(token, options))
      .filter((result) => result.accepted)
      .sort((a, b) => b.score - a.score);

    const processed: Array<{
      mint: string;
      symbol?: string;
      score: number;
      peakMultiple: number;
      buyersFound: number;
      candidatesStored: number;
    }> = [];
    const skippedExisting: string[] = [];
    const errors: Array<{ mint: string; error: string }> = [];

    for (const item of eligible) {
      if (processed.length >= options.maxTokens) break;
      const existing = await this.db.getWinningTokenByMint(
        "solana",
        item.token.tokenAddress,
      );
      if (existing?.processed_for_wallets) {
        skippedExisting.push(item.token.tokenAddress);
        continue;
      }
      try {
        const result = await this.discoverWinningToken({
          mint: item.token.tokenAddress,
          peakMultiple: item.peakMultiple,
          maxBuyers: 100,
          minTradeUsd: 10,
        });
        processed.push({
          mint: item.token.tokenAddress,
          symbol: item.token.symbol,
          score: item.score,
          peakMultiple: item.peakMultiple,
          buyersFound: result.buyersFound,
          candidatesStored: result.candidatesStored,
        });
      } catch (error) {
        errors.push({
          mint: item.token.tokenAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      ok: true,
      scanned: discovered.length,
      eligible: eligible.length,
      processed,
      skippedExisting: skippedExisting.length,
      errors,
      filters: options,
    };
  }

  async feed() {
    const [recentCandidates, winningTokens, stats] = await Promise.all([
      this.db.listWalletCandidates(10, "recent"),
      this.db.listWinningTokens(30),
      this.db.sourcingStats(),
    ]);
    return {
      candidates: recentCandidates.map(publicCandidate),
      winningTokens: winningTokens.map(publicWinningToken),
      stats: publicSourcingStats(stats),
    };
  }

  async candidateDetail(id: string) {
    const [sources, analysis] = await Promise.all([
      this.db.candidateSources(id),
      this.db.candidateAnalysis(id),
    ]);
    return { sources, analysis: publicAnalysis(analysis) };
  }

  async analyzeCandidate(id: string) {
    const candidate = await this.db.getWalletCandidate(id);
    if (!candidate) {
      throw Object.assign(new Error("CANDIDATE_NOT_FOUND"), {
        statusCode: 404,
      });
    }
    const sources = await this.db.candidateSources(id);
    const swaps = await this.earlyBuyers.findWalletSwaps({
      wallet: candidate.wallet_address,
      limit: 100,
      quoteMints: [SOLANA_USDC, SOLANA_USDT, SOLANA_WS0L],
    });
    const report = buildCandidateAnalysis(candidate, sources, swaps);
    const saved = await this.db.upsertWalletCandidateAnalysis({
      candidateId: id,
      ...report,
    });
    return { ok: true, analysis: publicAnalysis(saved) };
  }

  async analyzeWallet(input: { wallet: string; label?: string | null }) {
    const wallet = input.wallet.trim();
    try {
      new PublicKey(wallet);
    } catch {
      throw Object.assign(new Error("INVALID_SOLANA_WALLET"), {
        statusCode: 400,
      });
    }
    const candidate = await this.db.upsertWalletCandidate({
      chain: "solana",
      walletAddress: wallet,
      displayName: input.label?.trim() || null,
      metadata: { firstSource: "MANUAL_WALLET_ANALYSIS" },
    });
    await this.db.addWalletCandidateSource({
      candidateId: candidate.id,
      sourceType: "MANUAL_WALLET_ANALYSIS",
      sourceProvider: this.earlyBuyers.provider,
      sourceEntity: wallet,
      sourceEventId: `manual:${wallet}`,
      observedAt: new Date(),
      metadata: { label: input.label ?? null },
    });
    await this.db.recalculateWalletSourceStats();
    const result = await this.analyzeCandidate(candidate.id);
    return {
      ok: true,
      candidate: publicCandidate({
        ...candidate,
        recommendation: result.analysis?.recommendation,
        qualification_score: result.analysis?.qualification_score,
        total_swaps: result.analysis?.total_swaps,
        buy_count: result.analysis?.buy_count,
        sell_count: result.analysis?.sell_count,
        distinct_tokens: result.analysis?.distinct_tokens,
        winning_token_hits: result.analysis?.winning_token_hits,
        five_x_hits: result.analysis?.five_x_hits,
        recent_non_winning_buys: result.analysis?.recent_non_winning_buys,
        trades_per_day: result.analysis?.trades_per_day,
        median_hold_minutes: result.analysis?.median_hold_minutes,
        sell_coverage_pct: result.analysis?.sell_coverage_pct,
        possible_bot: result.analysis?.possible_bot,
        possible_router: result.analysis?.possible_router,
        possible_deployer: result.analysis?.possible_deployer,
        uses_multiple_fee_payers: result.analysis?.uses_multiple_fee_payers,
        warnings: result.analysis?.warnings,
        strengths: result.analysis?.strengths,
        analysis_metadata: result.analysis?.metadata,
        source_types: ["MANUAL_WALLET_ANALYSIS"],
      }),
      analysis: result.analysis,
    };
  }

  async bestCandidates(limit = 5, kind: "disciplined" | "aggressive" = "disciplined") {
    const candidates = await this.db.listWalletCandidates(50, "priority");
    const analyzed: any[] = [];
    for (const candidate of candidates) {
      if (
        !candidate.recommendation &&
        analyzed.length < 15 &&
        Number(candidate.source_priority ?? 0) >= 40
      ) {
        try {
          await this.analyzeCandidate(candidate.id);
        } catch {
          // Keep ranking from existing evidence if a provider call fails.
        }
      }
      analyzed.push(candidate);
    }
    const refreshed = await this.db.listWalletCandidates(50, "priority");
    const best = refreshed
      .map(publicCandidate)
      .filter((candidate: any) => isBestCandidateForKind(candidate, kind))
      .sort((a: any, b: any) => bestScore(b, kind) - bestScore(a, kind))
      .slice(0, limit);
    return { wallets: best };
  }
}

function isBestCandidateForKind(candidate: any, kind: "disciplined" | "aggressive") {
  const analysis = candidate.analysis;
  if (!analysis) return false;
  if (Number(analysis.total_swaps ?? 0) <= 0) return false;
  if (analysis.recommendation === "REJECT_ROUTER_OR_DEPLOYER") return false;
  const strategy = analysis.strategy_type ?? analysis.metadata?.strategy_type;
  if (kind === "aggressive") {
    return (
      strategy === "AGGRESSIVE_BOT" ||
      analysis.recommendation === "AGGRESSIVE_BOT_CANDIDATE"
    );
  }
  return (
    strategy === "DISCIPLINED_FAST_TRADER" ||
    analysis.recommendation === "DISCIPLINED_FAST_TRADER" ||
    analysis.recommendation === "STRONG_CANDIDATE"
  );
}

function bestScore(candidate: any, kind: "disciplined" | "aggressive") {
  const analysis = candidate.analysis;
  const copyScore = Number(analysis?.copy_score ?? analysis?.metadata?.copy_score ?? analysis?.qualification_score ?? 0);
  const riskScore = Number(analysis?.risk_score ?? analysis?.metadata?.risk_score ?? 0);
  return (
    copyScore * 1.8 +
    Number(candidate.source_priority ?? 0) * 0.8 +
    Number(candidate.winning_token_appearances ?? 0) * 10 +
    Number(candidate.five_x_appearances ?? 0) * 8 -
    (kind === "disciplined" ? riskScore * 0.35 : riskScore * 0.15) -
    (analysis?.recommendation === "PAPER_ONLY" ? 20 : 0) -
    (analysis?.recommendation === "WATCH_MORE" ? 35 : 0)
  );
}

export function buildCandidateAnalysis(candidate: any, sources: any[], swaps: WalletSwap[]) {
  const buys = swaps.filter((swap) => swap.side === "buy");
  const sells = swaps.filter((swap) => swap.side === "sell");
  const boughtTokens = new Set(buys.map((swap) => swap.token));
  const soldTokens = new Set(sells.map((swap) => swap.token));
  const sourceTokens = new Set(
    sources
      .map((source) => source.token_mint)
      .filter((token): token is string => Boolean(token)),
  );
  const fiveXTokens = new Set(
    sources
      .filter((source) => Number(source.metadata?.tokenPeakMultiple ?? 0) >= 5)
      .map((source) => source.token_mint)
      .filter((token): token is string => Boolean(token)),
  );
  const tenXTokens = new Set(
    sources
      .filter((source) => Number(source.metadata?.tokenPeakMultiple ?? 0) >= 10)
      .map((source) => source.token_mint)
      .filter((token): token is string => Boolean(token)),
  );
  const winningTokenHits = sourceTokens.size;
  const fiveXHits = fiveXTokens.size;
  const tenXHits = tenXTokens.size;
  const recentNonWinningBuys = [...boughtTokens].filter(
    (token) => !sourceTokens.has(token),
  ).length;
  const firstAt = swaps.length
    ? Math.min(...swaps.map((swap) => swap.timestamp.getTime()))
    : Date.now();
  const lastAt = swaps.length
    ? Math.max(...swaps.map((swap) => swap.timestamp.getTime()))
    : Date.now();
  const activeDays = Math.max(1, (lastAt - firstAt) / 86_400_000);
  const tradesPerDay = swaps.length ? swaps.length / activeDays : 0;
  const holdMinutes = estimateHoldMinutes(buys, sells);
  const medianHoldMinutes = median(holdMinutes);
  const sellCoveragePct = boughtTokens.size
    ? (100 * [...boughtTokens].filter((token) => soldTokens.has(token)).length) /
      boughtTokens.size
    : null;
  const buySellBalance = buys.length
    ? Math.min(100, (sells.length / buys.length) * 100)
    : 0;
  const nonWinningRatio = boughtTokens.size
    ? recentNonWinningBuys / boughtTokens.size
    : 0;
  const feePayers = new Set(
    swaps.map((swap) => swap.feePayer).filter((feePayer): feePayer is string => Boolean(feePayer)),
  );
  const externalFeePayers = [...feePayers].filter(
    (feePayer) => feePayer !== candidate.wallet_address,
  );
  const usesMultipleFeePayers = externalFeePayers.length >= 3;
  const possibleBot =
    tradesPerDay > 80 ||
    swaps.length >= 90 ||
    (boughtTokens.size >= 35 && swaps.length >= 60);
  const possibleRouter =
    usesMultipleFeePayers ||
    (sells.length > buys.length * 2 && swaps.length > 25) ||
    (feePayers.size >= 8 && swaps.length >= 30);
  const possibleDeployer =
    sellCoveragePct != null &&
    sellCoveragePct < 5 &&
    boughtTokens.size >= 25 &&
    winningTokenHits <= 1;
  const sellTooEarly =
    medianHoldMinutes != null && medianHoldMinutes < 10 && fiveXHits >= 2;

  const sourcePriority = Number(candidate.source_priority ?? 0);
  const rankBoost = candidate.median_buyer_rank == null
    ? 0
    : Math.max(0, 16 - Number(candidate.median_buyer_rank) / 5);
  const evidenceScore = clamp(
    sourcePriority * 0.35 +
      Math.min(35, winningTokenHits * 9) +
      Math.min(25, fiveXHits * 8) +
      rankBoost +
      (swaps.length ? 10 : 0),
  );
  const winRepeatScore = clamp(
    winningTokenHits * 16 + fiveXHits * 18 + tenXHits * 12 + rankBoost,
  );
  const holdScore = medianHoldMinutes == null
    ? 35
    : medianHoldMinutes < 5
      ? 15
      : medianHoldMinutes < 20
        ? 45
        : medianHoldMinutes <= 720
          ? 78
          : 62;
  const exitQualityScore = clamp(
    (sellCoveragePct ?? 0) * 0.55 + buySellBalance * 0.25 + holdScore * 0.2,
  );
  const botRiskScore = clamp(
    (possibleRouter ? 85 : 0) +
      (possibleDeployer ? 80 : 0) +
      (possibleBot ? 45 : 0) +
      (usesMultipleFeePayers ? 25 : 0) +
      (tradesPerDay > 150 ? 20 : tradesPerDay > 80 ? 10 : 0),
  );
  const riskScore = clamp(
    botRiskScore +
      (sellCoveragePct == null ? 20 : sellCoveragePct < 10 ? 20 : 0) +
      Math.min(25, nonWinningRatio * 25),
  );
  let copyScore =
    evidenceScore * 0.4 +
    winRepeatScore * 0.3 +
    exitQualityScore * 0.3 -
    (possibleRouter || possibleDeployer ? 50 : 0) -
    Math.min(20, nonWinningRatio * 20) -
    (!swaps.length ? 25 : 0);
  if (possibleBot && !possibleRouter && !possibleDeployer && winningTokenHits >= 3) {
    copyScore += 8;
  }
  copyScore = clamp(copyScore);

  const strengths: string[] = [];
  const warnings: string[] = [];
  if (winningTokenHits >= 2)
    strengths.push(`Repeated early buyer across ${winningTokenHits} winning tokens`);
  if (fiveXHits >= 2) strengths.push(`Early in ${fiveXHits} tokens that moved 5x+`);
  if (tenXHits >= 1) strengths.push(`Caught ${tenXHits} token${tenXHits === 1 ? "" : "s"} that moved 10x+`);
  if (sourcePriority >= 75) strengths.push("High sourcing priority");
  if (medianHoldMinutes != null && medianHoldMinutes >= 20)
    strengths.push(`Median observed hold about ${Math.round(medianHoldMinutes)} minutes`);
  if (sellCoveragePct != null && sellCoveragePct >= 30)
    strengths.push(`Observed sells for ${Math.round(sellCoveragePct)}% of bought tokens`);
  if (possibleBot && !possibleRouter && !possibleDeployer)
    strengths.push("Fast/high-frequency wallet with repeated winner evidence");
  if (possibleBot) warnings.push("High-frequency or very broad token activity");
  if (possibleRouter) warnings.push("Router-like fee-payer or sell pattern");
  if (possibleDeployer) warnings.push("Deployer/farm-like pattern with poor exit evidence");
  if (sellTooEarly) warnings.push("Often sells quickly after buying");
  if (nonWinningRatio > 0.8 && boughtTokens.size >= 10)
    warnings.push("Many recent buys were not part of the winning-token evidence");
  if (sellCoveragePct != null && sellCoveragePct < 10 && boughtTokens.size >= 8)
    warnings.push("Very low observed sell coverage");
  if (!swaps.length) warnings.push("No recent wallet swap history returned by provider");

  let strategyType: "DISCIPLINED_FAST_TRADER" | "AGGRESSIVE_BOT" | "UNKNOWN" = "UNKNOWN";
  let recommendation: string;
  if (possibleRouter || possibleDeployer) {
    recommendation = "REJECT_ROUTER_OR_DEPLOYER";
  } else if (!swaps.length) {
    recommendation = "WATCH_MORE";
  } else if (
    !possibleBot &&
    copyScore >= 70 &&
    winningTokenHits >= 2 &&
    (sellCoveragePct ?? 0) >= 20
  ) {
    strategyType = "DISCIPLINED_FAST_TRADER";
    recommendation = "DISCIPLINED_FAST_TRADER";
  } else if (
    possibleBot &&
    copyScore >= 65 &&
    (winningTokenHits >= 3 || fiveXHits >= 2) &&
    (sellCoveragePct ?? 0) >= 10
  ) {
    strategyType = "AGGRESSIVE_BOT";
    recommendation = "AGGRESSIVE_BOT_CANDIDATE";
  } else if (copyScore >= 50 || winningTokenHits >= 2) {
    recommendation = "PAPER_ONLY";
  } else {
    recommendation = "WATCH_MORE";
  }

  return {
    recommendation,
    qualificationScore: copyScore,
    totalSwaps: swaps.length,
    buyCount: buys.length,
    sellCount: sells.length,
    distinctTokens: boughtTokens.size,
    winningTokenHits,
    fiveXHits,
    recentNonWinningBuys,
    tradesPerDay,
    medianHoldMinutes,
    sellCoveragePct,
    possibleBot,
    possibleRouter,
    possibleDeployer,
    usesMultipleFeePayers,
    warnings,
    strengths,
    metadata: {
      strategy_type: strategyType,
      copy_score: copyScore,
      risk_score: riskScore,
      evidence_score: evidenceScore,
      win_repeat_score: winRepeatScore,
      exit_quality_score: exitQualityScore,
      bot_risk_score: botRiskScore,
      ten_x_hits: tenXHits,
      non_winning_ratio: nonWinningRatio,
      sampled_swaps: swaps.slice(0, 20).map((swap) => ({
        signature: swap.signature,
        timestamp: swap.timestamp.toISOString(),
        side: swap.side,
        token: swap.token,
        tokenAmount: swap.tokenAmount,
        quoteAmount: swap.quoteAmount,
      })),
      caveat:
        "This is copy-worthiness scoring from sourcing evidence and recent swap behavior. Paper-follow first before live.",
    },
  };
}

function estimateHoldMinutes(buys: WalletSwap[], sells: WalletSwap[]) {
  const minutes: number[] = [];
  for (const buy of buys) {
    const sell = sells
      .filter(
        (candidate) =>
          candidate.token === buy.token &&
          candidate.timestamp.getTime() > buy.timestamp.getTime(),
      )
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
    if (sell) {
      minutes.push(
        (sell.timestamp.getTime() - buy.timestamp.getTime()) / 60_000,
      );
    }
  }
  return minutes;
}

function clamp(value: number, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function evaluateDiscoveryToken(
  token: DiscoveryToken,
  options: SourcingScanOptions,
) {
  const ageMinutes = token.pairCreatedAt
    ? (Date.now() - token.pairCreatedAt.getTime()) / 60_000
    : null;
  const peakMultiple = Math.max(
    1 + token.priceChangeM5Pct / 100,
    1 + token.priceChangeH1Pct / 100,
    1 + token.priceChangeH6Pct / 100,
    1 + token.priceChangeH24Pct / 100,
  );
  const accepted =
    token.liquidityUsd >= options.minLiquidityUsd &&
    (token.volumeH1Usd >= options.minVolumeH1Usd ||
      token.volumeH6Usd >= options.minVolumeH1Usd * 2) &&
    (token.txnsH1 >= options.minTxnsH1 ||
      token.txnsH6 >= options.minTxnsH1 * 3) &&
    peakMultiple >= options.minPeakMultiple &&
    (ageMinutes == null ||
      (ageMinutes >= options.minAgeMinutes &&
        ageMinutes <= options.maxAgeHours * 60));

  const score =
    peakMultiple * 25 +
    Math.min(20, token.liquidityUsd / 5_000) +
    Math.min(20, token.volumeH1Usd / 2_500) +
    Math.min(15, token.txnsH1 / 5) +
    token.sources.length * 4 -
    (ageMinutes == null ? 0 : Math.min(10, ageMinutes / 360));

  return { token, accepted, score, peakMultiple };
}

function isObviousNonCandidate(wallet: string) {
  // Basic guard only. The deeper deployer/router/pool classification belongs in later phases.
  return !wallet || wallet.length < 32;
}

function publicCandidate(row: any) {
  return {
    id: row.id,
    chain: row.chain,
    wallet_address: row.wallet_address,
    display_name: row.display_name,
    source_priority: Number(row.source_priority ?? 0),
    source_count: Number(row.source_count ?? 0),
    analysis_status: row.analysis_status,
    first_discovered_at: row.first_discovered_at,
    last_discovered_at: row.last_discovered_at,
    winning_token_appearances: Number(row.winning_token_appearances ?? 0),
    five_x_appearances: Number(row.five_x_appearances ?? 0),
    ten_x_appearances: Number(row.ten_x_appearances ?? 0),
    unique_source_types: Number(row.unique_source_types ?? 0),
    unique_tokens: Number(row.unique_tokens ?? 0),
    median_buyer_rank:
      row.median_buyer_rank == null ? null : Number(row.median_buyer_rank),
    source_types: row.source_types ?? [],
    analysis: publicAnalysis(row.recommendation ? row : null),
  };
}

function publicWinningToken(row: any) {
  return {
    id: row.id,
    chain: row.chain,
    token_mint: row.token_mint,
    detected_at: row.detected_at,
    peak_multiple: row.peak_multiple == null ? null : Number(row.peak_multiple),
    liquidity_usd: row.liquidity_usd == null ? null : Number(row.liquidity_usd),
    discovery_reason: row.discovery_reason,
    source_provider: row.source_provider,
    early_buyer_count: Number(row.early_buyer_count ?? 0),
    metadata: row.metadata ?? {},
  };
}

function publicSourcingStats(row: any) {
  return {
    candidate_count: Number(row?.candidate_count ?? 0),
    winning_token_count: Number(row?.winning_token_count ?? 0),
    processed_token_count: Number(row?.processed_token_count ?? 0),
    last_token_detected_at: row?.last_token_detected_at ?? null,
    last_candidate_discovered_at: row?.last_candidate_discovered_at ?? null,
  };
}

function publicAnalysis(row: any) {
  if (!row) return null;
  const metadata = row.analysis_metadata ?? row.metadata ?? {};
  return {
    analyzed_at: row.analyzed_at,
    recommendation: row.recommendation,
    strategy_type: metadata.strategy_type ?? "UNKNOWN",
    qualification_score: Number(row.qualification_score ?? metadata.copy_score ?? 0),
    copy_score: Number(metadata.copy_score ?? row.qualification_score ?? 0),
    risk_score: Number(metadata.risk_score ?? 0),
    evidence_score: Number(metadata.evidence_score ?? 0),
    win_repeat_score: Number(metadata.win_repeat_score ?? 0),
    exit_quality_score: Number(metadata.exit_quality_score ?? 0),
    bot_risk_score: Number(metadata.bot_risk_score ?? 0),
    ten_x_hits: Number(metadata.ten_x_hits ?? 0),
    total_swaps: Number(row.total_swaps ?? 0),
    buy_count: Number(row.buy_count ?? 0),
    sell_count: Number(row.sell_count ?? 0),
    distinct_tokens: Number(row.distinct_tokens ?? 0),
    winning_token_hits: Number(row.winning_token_hits ?? 0),
    five_x_hits: Number(row.five_x_hits ?? 0),
    recent_non_winning_buys: Number(row.recent_non_winning_buys ?? 0),
    trades_per_day:
      row.trades_per_day == null ? null : Number(row.trades_per_day),
    median_hold_minutes:
      row.median_hold_minutes == null
        ? null
        : Number(row.median_hold_minutes),
    sell_coverage_pct:
      row.sell_coverage_pct == null ? null : Number(row.sell_coverage_pct),
    possible_bot: Boolean(row.possible_bot),
    possible_router: Boolean(row.possible_router),
    possible_deployer: Boolean(row.possible_deployer),
    uses_multiple_fee_payers: Boolean(row.uses_multiple_fee_payers),
    warnings: row.warnings ?? [],
    strengths: row.strengths ?? [],
    metadata,
    sampled_swaps: metadata.sampled_swaps ?? [],
  };
}
