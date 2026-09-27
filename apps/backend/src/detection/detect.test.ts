import assert from "node:assert/strict";
import test from "node:test";
import { detectForWallet } from "./detect.js";
import type { TransactionSnapshot } from "./types.js";

const WALLET = "TraderWallet111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenMint111111111111111111111111111111111";

function base(): TransactionSnapshot {
  return {
    chain: "solana",
    txHash: "tx1",
    accountKeys: [WALLET, "tokenacct", "other"],
    signerAddresses: [WALLET],
    preNativeBalances: [1_000_000_000n, 0n, 1_000_000_000n],
    postNativeBalances: [999_995_000n, 0n, 1_000_000_000n],
    feeLamports: 5_000n,
    feePayer: WALLET,
    preTokenBalances: [],
    postTokenBalances: [],
  };
}

test("detects USDC -> token buy", () => {
  const tx = base();
  tx.preTokenBalances = [
    { accountIndex: 1, owner: WALLET, mint: USDC, amount: 20_000_000n },
    { accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 0n },
  ];
  tx.postTokenBalances = [
    { accountIndex: 1, owner: WALLET, mint: USDC, amount: 10_000_000n },
    { accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 1_000_000n },
  ];
  const events = detectForWallet(tx, WALLET);
  assert.equal(events.length, 1);
  assert.equal(events[0].classification, "buy");
  assert.equal(events[0].quoteAsset, USDC);
  assert.equal(events[0].preTokenAmountRaw, 0n);
  assert.equal(events[0].requiresLiquidityCheck, false);
});

test("does not classify a free airdrop as a buy", () => {
  const tx = base();
  tx.preTokenBalances = [{ accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 0n }];
  tx.postTokenBalances = [{ accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 1_000_000n }];
  const events = detectForWallet(tx, WALLET);
  assert.equal(events.length, 0);
});

test("subtracts token-account rent from SOL outflow", () => {
  const tx = base();
  tx.preNativeBalances = [1_000_000_000n, 0n, 1_000_000_000n];
  tx.postNativeBalances = [997_955_720n, 2_039_280n, 1_000_000_000n]; // 0.00203928 SOL rent + 5000 fee
  tx.preTokenBalances = [];
  tx.postTokenBalances = [{ accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 1_000_000n }];
  const events = detectForWallet(tx, WALLET);
  assert.equal(events.length, 0);
});

test("marks relay-style receive for liquidity verification", () => {
  const tx = base();
  tx.accountKeys = [WALLET, "tokenacct", "payer"];
  tx.preNativeBalances = [1_000_000_000n, 0n, 2_000_000_000n];
  tx.postNativeBalances = [999_995_000n, 0n, 1_900_000_000n];
  tx.preTokenBalances = [{ accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 0n }];
  tx.postTokenBalances = [{ accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 1_000_000n }];
  const events = detectForWallet(tx, WALLET);
  assert.equal(events.length, 1);
  assert.equal(events[0].requiresLiquidityCheck, true);
});

test("detects token -> USDC partial sell", () => {
  const tx = base();
  tx.preTokenBalances = [
    { accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 5_000_000n, decimals: 6 },
    { accountIndex: 1, owner: WALLET, mint: USDC, amount: 10_000_000n, decimals: 6 },
  ];
  tx.postTokenBalances = [
    { accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 2_000_000n, decimals: 6 },
    { accountIndex: 1, owner: WALLET, mint: USDC, amount: 15_000_000n, decimals: 6 },
  ];
  const events = detectForWallet(tx, WALLET);
  assert.equal(events.length, 1);
  assert.equal(events[0].classification, "partial_exit");
  assert.equal(events[0].quoteAsset, USDC);
  assert.equal(events[0].quoteAmountRaw, 5_000_000n);
  assert.equal(events[0].tokenAmountRaw, 3_000_000n);
});

test("detects token -> USDC full sell", () => {
  const tx = base();
  tx.preTokenBalances = [
    { accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 5_000_000n, decimals: 6 },
    { accountIndex: 1, owner: WALLET, mint: USDC, amount: 10_000_000n, decimals: 6 },
  ];
  tx.postTokenBalances = [
    { accountIndex: 1, owner: WALLET, mint: TOKEN, amount: 0n, decimals: 6 },
    { accountIndex: 1, owner: WALLET, mint: USDC, amount: 15_000_000n, decimals: 6 },
  ];
  const events = detectForWallet(tx, WALLET);
  assert.equal(events.length, 1);
  assert.equal(events[0].classification, "full_exit");
  assert.equal(events[0].quoteAsset, USDC);
  assert.equal(events[0].quoteAmountRaw, 5_000_000n);
  assert.equal(events[0].tokenAmountRaw, 5_000_000n);
});
