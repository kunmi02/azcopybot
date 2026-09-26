import type { DetectionCandidate, TokenAccountBalance, TransactionSnapshot } from "./types.js";

const SOL_MINT = "native";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export const SOLANA_QUOTES = new Map([
  [SOL_MINT, "SOL"],
  [WSOL, "wSOL"],
  [USDC, "USDC"],
  [USDT, "USDT"],
]);

function aggregateByOwnerAndMint(balances: TokenAccountBalance[]) {
  const map = new Map<string, bigint>();
  for (const b of balances) {
    if (!b.owner) continue;
    const key = `${b.owner}\u0000${b.mint}`;
    map.set(key, (map.get(key) ?? 0n) + b.amount);
  }
  return map;
}

function getTokenAmount(map: Map<string, bigint>, owner: string, mint: string) {
  return map.get(`${owner}\u0000${mint}`) ?? 0n;
}

function tokenDecimals(snapshot: TransactionSnapshot, owner: string, mint: string) {
  const balance = [...snapshot.postTokenBalances, ...snapshot.preTokenBalances]
    .find((b) => b.owner === owner && b.mint === mint && b.decimals != null);
  return balance?.decimals;
}

function rentDepositedFor(wallet: string, snapshot: TransactionSnapshot): bigint {
  let rent = 0n;
  for (const b of snapshot.postTokenBalances) {
    if (b.owner !== wallet) continue;
    const pre = snapshot.preNativeBalances[b.accountIndex] ?? 0n;
    const post = snapshot.postNativeBalances[b.accountIndex] ?? 0n;
    if (pre === 0n && post > 0n) rent += post;
  }
  return rent;
}

function effectiveNativeOutflow(wallet: string, snapshot: TransactionSnapshot): bigint {
  const i = snapshot.accountKeys.indexOf(wallet);
  if (i < 0) return 0n;
  const pre = snapshot.preNativeBalances[i] ?? 0n;
  const post = snapshot.postNativeBalances[i] ?? 0n;
  let spent = pre > post ? pre - post : 0n;
  spent -= spent > rentDepositedFor(wallet, snapshot) ? rentDepositedFor(wallet, snapshot) : spent;
  if (snapshot.feePayer === wallet && snapshot.feeLamports) {
    spent -= spent > snapshot.feeLamports ? snapshot.feeLamports : spent;
  }
  return spent > 0n ? spent : 0n;
}

function anyQuotePayment(snapshot: TransactionSnapshot, pre: Map<string, bigint>, post: Map<string, bigint>) {
  // SPL quote movement anywhere.
  for (const key of new Set([...pre.keys(), ...post.keys()])) {
    const [, mint] = key.split("\u0000");
    if (!SOLANA_QUOTES.has(mint) || mint === SOL_MINT) continue;
    if ((pre.get(key) ?? 0n) > (post.get(key) ?? 0n)) return true;
  }

  // Native SOL movement anywhere after removing the known fee from the fee payer.
  for (let i = 0; i < snapshot.accountKeys.length; i++) {
    const address = snapshot.accountKeys[i];
    let out = (snapshot.preNativeBalances[i] ?? 0n) - (snapshot.postNativeBalances[i] ?? 0n);
    if (out <= 0n) continue;
    if (snapshot.feePayer === address && snapshot.feeLamports) out -= snapshot.feeLamports;
    const rent = rentDepositedFor(address, snapshot);
    out -= out > rent ? rent : out;
    if (out > 0n) return true;
  }
  return false;
}

/**
 * Pure classification. No network or database I/O.
 * Liquidity is intentionally checked by the caller when requiresLiquidityCheck=true.
 */
export function detectForWallet(
  snapshot: TransactionSnapshot,
  wallet: string,
  trackedOpenTokens: ReadonlySet<string> = new Set(),
): DetectionCandidate[] {
  if (!snapshot.signerAddresses.includes(wallet)) return [];

  const pre = aggregateByOwnerAndMint(snapshot.preTokenBalances);
  const post = aggregateByOwnerAndMint(snapshot.postTokenBalances);
  const mints = new Set<string>();
  for (const key of [...pre.keys(), ...post.keys()]) {
    const [owner, mint] = key.split("\u0000");
    if (owner === wallet) mints.add(mint);
  }

  const results: DetectionCandidate[] = [];

  // Full exit has priority for tracked tokens.
  for (const mint of trackedOpenTokens) {
    if (SOLANA_QUOTES.has(mint)) continue;
    const before = getTokenAmount(pre, wallet, mint);
    const after = getTokenAmount(post, wallet, mint);
    if (before > 0n && after === 0n) {
      results.push({ classification: "full_exit", wallet, token: mint, tokenAmountRaw: before, tokenDecimals: tokenDecimals(snapshot, wallet, mint), requiresLiquidityCheck: false });
    }
  }

  const nativeSpend = effectiveNativeOutflow(wallet, snapshot);
  const quoteSpend: Array<{ mint: string; amount: bigint }> = [];
  if (nativeSpend > 0n) quoteSpend.push({ mint: SOL_MINT, amount: nativeSpend });
  for (const mint of [WSOL, USDC, USDT]) {
    const before = getTokenAmount(pre, wallet, mint);
    const after = getTokenAmount(post, wallet, mint);
    if (before > after) quoteSpend.push({ mint, amount: before - after });
  }

  const paymentSomewhere = anyQuotePayment(snapshot, pre, post);

  for (const mint of mints) {
    if (SOLANA_QUOTES.has(mint)) continue;
    const before = getTokenAmount(pre, wallet, mint);
    const after = getTokenAmount(post, wallet, mint);
    if (after <= before) continue;

    const acquired = after - before;
    const paired = quoteSpend.sort((a, b) => (a.amount > b.amount ? -1 : 1))[0];
    if (paired) {
      results.push({
        classification: "buy",
        wallet,
        token: mint,
        quoteAsset: paired.mint,
        quoteAmountRaw: paired.amount,
        tokenAmountRaw: acquired,
        preTokenAmountRaw: before,
        tokenDecimals: tokenDecimals(snapshot, wallet, mint),
        requiresLiquidityCheck: false,
      });
      continue;
    }

    // Relay/solver-style candidate: the watched wallet received tokens, while a quote asset
    // moved elsewhere in the transaction. The caller must require >= $1,000 liquidity.
    if (paymentSomewhere) {
      results.push({
        classification: "buy",
        wallet,
        token: mint,
        tokenAmountRaw: acquired,
        preTokenAmountRaw: before,
        tokenDecimals: tokenDecimals(snapshot, wallet, mint),
        requiresLiquidityCheck: true,
      });
    }
  }

  return results;
}
