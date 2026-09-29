import type { Database } from "../db.js";
import type {
  DexScreenerPriceService,
  DiscoveryToken,
} from "./pricing.js";
import type { EarlyBuyerSource } from "../sources/helius.js";
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
    private readonly earlyBuyers: EarlyBuyerSource,
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
    const [candidates, winningTokens, stats] = await Promise.all([
      this.db.listWalletCandidates(50),
      this.db.listWinningTokens(30),
      this.db.sourcingStats(),
    ]);
    return {
      candidates: candidates.map(publicCandidate),
      winningTokens: winningTokens.map(publicWinningToken),
      stats: publicSourcingStats(stats),
    };
  }

  async candidateDetail(id: string) {
    const sources = await this.db.candidateSources(id);
    return { sources };
  }
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
