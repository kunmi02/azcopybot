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

  async bestCandidates(limit = 5) {
    const candidates = await this.db.listWalletCandidates(25, "priority");
    const analyzed: any[] = [];
    for (const candidate of candidates) {
      if (
        !candidate.recommendation &&
        analyzed.length < 10 &&
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
    const refreshed = await this.db.listWalletCandidates(25, "priority");
    const best = refreshed
      .map(publicCandidate)
      .filter((candidate: any) => {
        const analysis = candidate.analysis;
        return (
          analysis &&
          Number(analysis.total_swaps ?? 0) > 0 &&
          analysis.recommendation !== "REJECT_BOT_OR_ROUTER_RISK"
        );
      })
      .sort((a: any, b: any) => bestScore(b) - bestScore(a))
      .slice(0, limit);
    return { wallets: best };
  }
}

function bestScore(candidate: any) {
  const analysis = candidate.analysis;
  return (
    Number(analysis?.qualification_score ?? 0) * 1.5 +
    Number(candidate.source_priority ?? 0) +
    Number(candidate.winning_token_appearances ?? 0) * 12 +
    Number(candidate.five_x_appearances ?? 0) * 8 -
    (analysis?.recommendation === "WATCH_MORE" ? 15 : 0)
  );
}

function buildCandidateAnalysis(candidate: any, sources: any[], swaps: WalletSwap[]) {
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
  const winningTokenHits = sourceTokens.size;
  const fiveXHits = fiveXTokens.size;
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
    usesMultipleFeePayers || (sells.length > buys.length * 2 && swaps.length > 25);
  const possibleDeployer = false;
  const sellTooEarly =
    medianHoldMinutes != null && medianHoldMinutes < 10 && fiveXHits >= 2;
  const nonWinningRatio = boughtTokens.size
    ? recentNonWinningBuys / boughtTokens.size
    : 0;

  const strengths: string[] = [];
  const warnings: string[] = [];
  if (winningTokenHits >= 2)
    strengths.push(`Repeated early buyer across ${winningTokenHits} winning tokens`);
  if (fiveXHits >= 2) strengths.push(`Early in ${fiveXHits} tokens that moved 5x+`);
  if (Number(candidate.source_priority ?? 0) >= 75)
    strengths.push("High sourcing priority");
  if (medianHoldMinutes != null && medianHoldMinutes >= 30)
    strengths.push(`Median observed hold about ${Math.round(medianHoldMinutes)} minutes`);
  if (possibleBot) warnings.push("High-frequency or very broad token activity");
  if (possibleRouter) warnings.push("Router/bot-like fee-payer or sell pattern");
  if (sellTooEarly) warnings.push("Often sells quickly after buying");
  if (nonWinningRatio > 0.8 && boughtTokens.size >= 10)
    warnings.push("Many recent buys were not part of the winning-token evidence");
  if (!swaps.length) warnings.push("No recent wallet swap history returned by provider");

  let qualificationScore =
    Math.min(45, Number(candidate.source_priority ?? 0) * 0.45) +
    winningTokenHits * 11 +
    fiveXHits * 8 +
    (medianHoldMinutes == null ? 0 : medianHoldMinutes >= 30 ? 10 : -6) +
    (sellCoveragePct == null ? 0 : sellCoveragePct >= 25 ? 5 : -4) -
    Math.min(24, nonWinningRatio * 24) -
    (possibleBot ? 30 : 0) -
    (possibleRouter ? 25 : 0);
  qualificationScore = Math.max(0, Math.min(100, qualificationScore));
  if (!swaps.length) qualificationScore = Math.min(qualificationScore, 45);

  const recommendation =
    !swaps.length
      ? "WATCH_MORE"
      : possibleBot || possibleRouter
      ? "REJECT_BOT_OR_ROUTER_RISK"
      : qualificationScore >= 75 && winningTokenHits >= 2
        ? "STRONG_CANDIDATE"
        : qualificationScore >= 50
          ? "PAPER_ONLY"
          : "WATCH_MORE";

  return {
    recommendation,
    qualificationScore,
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
      sampledSwaps: swaps.slice(0, 20).map((swap) => ({
        signature: swap.signature,
        timestamp: swap.timestamp.toISOString(),
        side: swap.side,
        token: swap.token,
        tokenAmount: swap.tokenAmount,
      })),
      caveat:
        "Win/loss is inferred from repeated early-buyer evidence and recent swap behavior. It does not prove realized PnL without full historical cost-basis reconstruction.",
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
  return {
    analyzed_at: row.analyzed_at,
    recommendation: row.recommendation,
    qualification_score: Number(row.qualification_score ?? 0),
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
    metadata: row.analysis_metadata ?? row.metadata ?? {},
  };
}
