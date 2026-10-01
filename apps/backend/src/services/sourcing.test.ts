import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidateAnalysis } from "./sourcing.js";
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
