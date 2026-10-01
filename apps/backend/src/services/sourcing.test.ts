import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidateAnalysis, SourcingService } from "./sourcing.js";
import type { WalletSwap } from "../sources/helius.js";

const baseCandidate = {
  wallet_address: "Wallet111111111111111111111111111111111111",
  source_priority: 90,
  median_buyer_rank: 4,
};

test("candidate analysis ranks disciplined fast traders separately", () => {
  const report = buildCandidateAnalysis(
    baseCandidate,
    sources(["A", "B", "C"], [8, 6, 3]),
    swaps([
      ["buy", "A", 180],
      ["sell", "A", 150],
      ["buy", "B", 120],
      ["sell", "B", 90],
      ["buy", "C", 70],
      ["sell", "C", 20],
    ]),
  );

  assert.equal(report.recommendation, "DISCIPLINED_FAST_TRADER");
  assert.equal(report.metadata?.strategy_type, "DISCIPLINED_FAST_TRADER");
  assert.ok(report.qualificationScore >= 70);
  assert.ok(Number(report.metadata?.exit_quality_score) > 50);
});

test("candidate analysis keeps repeated high frequency winners as aggressive bot candidates", () => {
  const busySwaps: WalletSwap[] = [];
  for (let i = 0; i < 48; i++) {
    const token = `T${i % 12}`;
    busySwaps.push(swap("buy", token, 220 - i * 2));
    busySwaps.push(swap("sell", token, 219 - i * 2));
  }
  const report = buildCandidateAnalysis(
    baseCandidate,
    sources(["T0", "T1", "T2", "T3", "T4"], [12, 9, 7, 4, 3]),
    busySwaps,
  );

  assert.equal(report.recommendation, "AGGRESSIVE_BOT_CANDIDATE");
  assert.equal(report.metadata?.strategy_type, "AGGRESSIVE_BOT");
  assert.equal(report.possibleBot, true);
  assert.equal(report.possibleRouter, false);
});

test("candidate analysis rejects router-like wallets", () => {
  const routed = swaps([
    ["buy", "A", 60, "fee-a"],
    ["sell", "A", 55, "fee-b"],
    ["buy", "B", 50, "fee-c"],
    ["sell", "B", 45, "fee-d"],
    ["buy", "C", 40, "fee-e"],
    ["sell", "C", 35, "fee-f"],
  ]);
  const report = buildCandidateAnalysis(
    baseCandidate,
    sources(["A", "B", "C"], [8, 6, 3]),
    routed,
  );

  assert.equal(report.recommendation, "REJECT_ROUTER_OR_DEPLOYER");
  assert.equal(report.possibleRouter, true);
});

test("aggressive best lane includes up to five bot-like candidates by score", async () => {
  const botAnalysis = buildCandidateAnalysis(
    baseCandidate,
    sources(["T0", "T1", "T2"], [9, 6, 3]),
    Array.from({ length: 92 }, (_, i) =>
      swap(i % 2 === 0 ? "buy" : "sell", `T${i % 10}`, 300 - i),
    ),
  );
  const routerAnalysis = buildCandidateAnalysis(
    baseCandidate,
    sources(["A", "B", "C"], [8, 6, 3]),
    swaps([
      ["buy", "A", 60, "fee-a"],
      ["sell", "A", 55, "fee-b"],
      ["buy", "B", 50, "fee-c"],
      ["sell", "B", 45, "fee-d"],
      ["buy", "C", 40, "fee-e"],
      ["sell", "C", 35, "fee-f"],
    ]),
  );
  const candidates = [
    ...Array.from({ length: 6 }, (_, i) => publicCandidate(`bot-${i}`, botAnalysis, 95 - i)),
    publicCandidate("router", routerAnalysis, 100),
  ];
  const service = new SourcingService(
    {
      listWalletCandidates: async () => candidates,
      candidateSources: async () => [],
      getWalletCandidate: async () => null,
    } as any,
    {} as any,
    {} as any,
  );

  const result = await service.bestCandidates(5, "aggressive");

  assert.equal(result.wallets.length, 5);
  assert.ok(result.wallets.every((wallet: any) => wallet.id.startsWith("bot-")));
});

function sources(tokens: string[], multiples: number[]) {
  return tokens.map((token, index) => ({
    token_mint: token,
    metadata: { tokenPeakMultiple: multiples[index] },
  }));
}

function swaps(rows: Array<["buy" | "sell", string, number, string?]>) {
  return rows.map(([side, token, minutesAgo, feePayer]) =>
    swap(side, token, minutesAgo, feePayer),
  );
}

function swap(
  side: "buy" | "sell",
  token: string,
  minutesAgo: number,
  feePayer = baseCandidate.wallet_address,
): WalletSwap {
  return {
    signature: `${side}-${token}-${minutesAgo}-${feePayer}`,
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    side,
    token,
    tokenAmount: 1,
    quoteAmount: 1,
    feePayer,
  };
}

function publicCandidate(id: string, report: ReturnType<typeof buildCandidateAnalysis>, priority: number) {
  return {
    id,
    chain: "solana",
    wallet_address: `${id}Wallet111111111111111111111111111111`,
    source_priority: priority,
    source_count: 3,
    analysis_status: report.recommendation,
    winning_token_appearances: report.winningTokenHits,
    five_x_appearances: report.fiveXHits,
    ten_x_appearances: Number(report.metadata?.ten_x_hits ?? 0),
    unique_source_types: 1,
    unique_tokens: report.winningTokenHits,
    median_buyer_rank: 5,
    source_types: ["WINNING_TOKEN_EARLY_BUYER"],
    recommendation: report.recommendation,
    qualification_score: report.qualificationScore,
    total_swaps: report.totalSwaps,
    buy_count: report.buyCount,
    sell_count: report.sellCount,
    distinct_tokens: report.distinctTokens,
    winning_token_hits: report.winningTokenHits,
    five_x_hits: report.fiveXHits,
    recent_non_winning_buys: report.recentNonWinningBuys,
    trades_per_day: report.tradesPerDay,
    median_hold_minutes: report.medianHoldMinutes,
    sell_coverage_pct: report.sellCoveragePct,
    possible_bot: report.possibleBot,
    possible_router: report.possibleRouter,
    possible_deployer: report.possibleDeployer,
    uses_multiple_fee_payers: report.usesMultipleFeePayers,
    warnings: report.warnings,
    strengths: report.strengths,
    analysis_metadata: report.metadata,
  };
}
