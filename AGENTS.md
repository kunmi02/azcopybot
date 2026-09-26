# Copy-trading bot — implementation spec

**Audience: a coding agent.** This document is the source of truth for building
a wallet copy-trading bot. Drop it into the project as `CLAUDE.md` / `AGENTS.md`
or paste it as context.

It is derived from a running production system. Every constant, error string and
threshold below is real and was arrived at by something breaking. Treat the
numbers as load-bearing, not as illustrations.

**How to use it:** build in the order given in §11 and do not skip ahead to
execution. Sections 2 (constraints), 5 (detection) and 9 (failure modes) are the
ones that actually determine whether this works.

---

## 1. Goal

A long-lived service that:

1. Watches a configurable list of wallet addresses across Solana and optionally EVM chains.
2. Classifies each transaction they make as a buy, a full exit, or neither.
3. Posts an alert to Telegram within ~2 seconds.
4. Optionally mirrors buys and full exits with real funds from a separate trading wallet.

**Out of scope** unless explicitly requested later: web UI, multi-tenant
accounts, own indexer, MEV protection, custom AMM integrations, percentage-based
position sizing.

---

## 2. Hard constraints

These override convenience, style, and anything inferred from surrounding code.

- **NEVER** execute a real trade outside the single designated submit function.
  Exactly one function in the codebase may call `sendTransaction`. No test
  script, setup path, or helper may reach it.
- **NEVER** read a signing key from anywhere but an environment variable. Not
  the database, not a chat message, not a config file.
- **DEFAULT to dry-run.** A copy-trade configuration is simulation-only until an
  explicit, confirmed, user-initiated action sets it live. No migration,
  restart, or default value may flip that bit.
- **NEVER** sign a swap whose quote has not passed the value sanity check (§8).
- **The process is long-lived.** Do not target serverless. A gRPC subscription
  is not a request/response.
- **Detection MUST NOT** branch on which program or router executed a
  transaction. See §5.
- **Dedupe MUST** be durable (database), not an in-memory `Set`.

---

## 3. Stack

| Concern | Choice | Constraint it satisfies |
|---|---|---|
| Runtime | TypeScript executed by `tsx`, ESM, no build step | `tsx index.ts` is the whole deploy |
| Solana ingest | Yellowstone gRPC (`@triton-one/yellowstone-grpc`) | Streams at `processed`; webhooks are seconds behind |
| EVM ingest | `viem` `watchEvent` over WebSocket | One subscription per chain covers all wallets |
| Telegram | `grammY` | Inline keyboards for bounded choices |
| Database | Postgres (`pg`) | Durable dedupe + config |
| Swaps | Jupiter primary, OKX DEX aggregator fallback | Neither routes everything (§7) |
| Prices | DexScreener `/latest/dex/tokens/{addr}` | Free, multichain, keyless |
| Signing | `@solana/web3.js` + `tweetnacl` + `bs58` | — |

---

## 4. Module plan

Create these files. Keep each under ~400 lines; split when one grows past that.

| File | Responsibility |
|---|---|
| `index.ts` | Composition root: bot commands, event dispatch, live-execution paths |
| `types.ts` | `TradeEvent`, `Chain`, `WatchedWallet`, `dedupeKey()` |
| `detect.ts` | Pure classification from balance deltas. **No I/O.** |
| `chains/solana-grpc.ts` | Yellowstone subscription → `TradeEvent[]` |
| `chains/solana-history.ts` | JSON-RPC helper (`rpc<T>()`), historical queries |
| `chains/evm.ts` | Transfer-log subscription, receipt replay |
| `alert.ts` | Telegram message rendering, post-then-edit enrichment |
| `db.ts` | Schema, migrations, all SQL |
| `copytrade.ts` | Sizing, balance reads, dry-run rendering |
| `execute.ts` | Quote → route → sign → submit |
| `okx.ts` | Fallback router client |
| `wallet.ts` | Load signing keys from env |

`detect.ts` must stay pure and structurally typed so it can be tested against
both a gRPC protobuf payload and a plain JSON-RPC response without mocks.

---

## 5. Detection

### 5.1 The rule

Classify from the wallet's **signed balance deltas within one transaction**:

```
buy       := a non-quote token increased AND a quote asset decreased
full exit := a tracked token's balance went to exactly 0
neither   := everything else
```

Do not inspect program IDs, instruction discriminators, or router names. The
delta rule holds across Jupiter, Raydium, pump.fun, Meteora, Uniswap,
aggregators, solvers, and anything released after this was written.

### 5.2 Quote assets

```ts
const QUOTES: Record<Chain, Record<string, string>> = {
  solana: {
    native: "SOL",
    So11111111111111111111111111111111111111112: "wSOL",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  },
  ethereum: {
    native: "ETH",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  },
  // base, arbitrum, … same shape
};
```

EVM addresses compare case-insensitively. Solana base58 is case-**sensitive** —
never lowercase a mint.

### 5.3 Subtract rent before calling SOL "spent"

Creating a token account costs the recipient rent (~0.00204 SOL, and ~0.00156
for some layouts). A distribution where the recipient funds the receiving
accounts is otherwise identical to a purchase in delta terms: SOL out, tokens in.

```ts
// Lamports the wallet deposited into token accounts THIS tx created for it.
function rentDepositedFor(address, postTokenBalances, preBalances, postBalances): bigint {
  let rent = 0n;
  for (const b of postTokenBalances) {
    if (b.owner !== address) continue;
    const pre = BigInt(preBalances[b.accountIndex] ?? "0");
    const post = BigInt(postBalances[b.accountIndex] ?? "0");
    if (pre === 0n && post > 0n) rent += post;   // account created this tx
  }
  return rent;
}
```

Subtract this from the wallet's SOL outflow before deciding a payment occurred.
**Incident:** a 5-token distribution whose entire 0.0077978 SOL outflow was
exactly 5 × 0.00155956 of ATA rent was mirrored as five real buys.

### 5.4 Require a payment leg somewhere in the transaction

Some legitimate buys are relay/solver-executed and have no payment on the
recipient's own balance sheet — but *someone* paid, so a quote asset moves
somewhere in the transaction. A pure distribution has no quote asset moving at
all.

```
if (no quote asset moved anywhere in the tx) → not a buy
```

### 5.5 Liquidity floor for payment-less events

For events with no paired quote-asset leg, the discriminator is whether the
token has a real market — not the transfer size.

```ts
const MIN_LIQUIDITY_USD = 1000;   // DexScreener best-pool liquidity
```

Below the floor, drop silently.

---

## 6. Ingestion notes

- **Commitment: use `processed` consistently.** Solana RPC defaults to
  `finalized`, which is ~13s stale — an unqualified balance read reflects the
  world *before* the trade being reacted to. Every balance read on the detection
  path must pass `{ commitment: "processed" }` explicitly.
- Subscribe with `accountInclude: [...watchedAddresses]`, `vote: false`,
  `failed: false`.
- A watcher captures the wallet list at construction time. When the list
  changes, tear down and rebuild — and read §9.7, which is the single most
  expensive bug in this document.
- Dedupe key: `` `${chain}:${txHash}:${wallet}:${token}` ``. Insert-if-new must
  be atomic (`INSERT ... ON CONFLICT DO NOTHING RETURNING`), because alerting
  and copy-trading race the same event.

---

## 7. Execution

### 7.1 Routing decision

```
in parallel:
  A = primary quote (Jupiter /quote)
  B = transferFeeBps(mint)      // getAccountInfo, jsonParsed, read extensions

if (B === 0 && A succeeded)  → route via primary
else if (fallback configured) → route via fallback (OKX /swap)
else                          → skip with an explanatory message
```

Run the fee check **in parallel with** the quote so it adds no latency to the
common path.

**Critical ordering rule:** a non-zero transfer fee must override a
*successful* primary quote. That is precisely the dangerous case — the quote
succeeds through a dust pool and looks fine. See §9.5.

```ts
// Token-2022 transfer fee, basis points. 0 for ordinary SPL tokens.
// Read extensions[] for extension === "transferFeeConfig", then take
// max(newerTransferFee.transferFeeBasisPoints, olderTransferFee.…).
// On lookup failure return 0 — never block a trade on a failed read; the
// value sanity check in §8 is the backstop.
```

### 7.2 Signing and submission

Both routers return a base64 v0 `VersionedTransaction` with one signature slot,
so one path handles both. OKX returns its call data base58-encoded; decode to
bytes, then re-encode base64.

```ts
// 1. Blockhash MUST come from the node you will submit to.
const { blockhash } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);

// 2. Swap it in BEFORE signing — the signature covers the message it is in.
tx.message.recentBlockhash = blockhash;
tx.sign([keypair]);

// 3. Submit with preflight at confirmed.
rpc("sendTransaction", [base64, {
  encoding: "base64",
  skipPreflight: false,
  maxRetries: 3,
  preflightCommitment: "confirmed",   // NOT the default finalized
}]);
```

### 7.3 Retry rule

Retry **only** the error `Missing token program` (brand-new mint not yet indexed
by the swap-build endpoint): up to 3 attempts, ~700ms apart. Throw immediately
on every other error rather than burning latency on what will not fix itself.

### 7.4 Error surfacing

Preflight failures put the real cause in `error.data.logs`, not
`error.message` — the top-level message is usually just "Transaction simulation
failed". Fold the logs into the thrown message or every failure reads
identically.

---

## 8. Guards

| Guard | Rule |
|---|---|
| Dry-run default | Live requires explicit per-config opt-in (§2) |
| Value sanity check | Price the quote's output against an independent source (DexScreener). If `expectedUsd > 1 && quotedUsd < expectedUsd * 0.5` → refuse, alert, return. Applies to **both** buy and exit paths, and to **whichever router** won |
| Gas floor | A wallet needs SOL even when quoting in USDC (gas + ATA rent + route wrapping). Keep 0.05–0.1 SOL; check before quoting |
| Chat scoping | Every wallet and config belongs to specific chat ids. A removal must actually remove; an unknown wallet must never fall back to "all chats" (§9.7) |
| Confirmation | Anything outbound or irreversible confirms first |

Sizing: **flat per-trade amount**, not a percentage of balance. A percentage
compounds a losing streak downward and a winning one into sizes nobody chose.

---

## 9. Known failure modes

Each of these happened. Symptom → cause → fix.

### 9.1 Balance reads reflect a state that no longer exists
Unqualified RPC reads default to `finalized` (~13s stale) while detection runs
at `processed`. Pass `commitment` explicitly on every read.

### 9.2 Airdrops mirrored as real buys
ATA rent read as payment. Apply §5.3.

### 9.3 Free drops reported as buys
No payment leg anywhere. Apply §5.4 and §5.5.

### 9.4 `BlockhashNotFound` on every submission — two distinct causes
1. The aggregator built the transaction with a blockhash from *its* node; the
   submitting node hadn't caught up. → §7.2 step 1.
2. Preflight simulated at `finalized`, which cannot resolve a recent blockhash.
   → `preflightCommitment: "confirmed"`.

### 9.5 Token-2022 transfer-fee mints
Jupiter's Orca adapter rejects any pool whose mint carries a non-zero transfer
fee:

```
"Transfer fee config leading to non zero fee is not supported"
```

Two outcomes:
- `NO_ROUTES_FOUND` — loud, harmless.
- **A route through whatever dust pool remains** — observed: the real $13.9K
  pool excluded, quoted instead through a **$25** pool, $30 of USDC in for ~$8
  of token out, quote reporting 0.75% price impact. Silent.

The same exclusion applies on exit, so a fill you cannot sell is the real
hazard. Screen on **entry**, not just exit.

### 9.6 Swap fails with "insufficient lamports"
Trading wallet out of SOL. Holding $156 of USDC with 0.007 SOL fails every swap.
See the gas floor in §8.

### 9.7 A deleted wallet keeps alerting — and alerts chats it was never in
Two bugs in the watcher-rebuild seam, and you will write both:

1. **Teardown misses an in-flight subscription.** `stop()` sets a flag and
   destroys `stream`, but `stream` is only assigned *after* `subscribe()`
   resolves. A stop landing mid-subscribe destroys `undefined`; the stream then
   connects, wires itself to the handler, and nothing can kill it. It serves its
   original wallet list until the process restarts.

   ```ts
   const s = await client.subscribe(request);
   if (stopped) return s.destroy();   // re-check AFTER subscribe, not only after connect
   stream = s;
   ```

2. **Permissive dispatch fallback.** `walletChats.get(wallet) ?? ALL_CHAT_IDS`
   means an event from a stale watcher — a wallet no longer in the map — is
   broadcast to *every* chat. Deleting a wallet made it louder, not quieter.
   Drop unknown wallets:

   ```ts
   const chatIds = walletChats.get(event.wallet);
   if (!chatIds) return;   // watcher outlived its wallet list
   ```

### 9.8 Self-clearing wallet list without a database
If `wallets` and the fallback config array are the same reference, a rebuild
that does `wallets.length = 0` then re-reads from that array empties everything.
Copy the array.

---

## 10. Data model

```sql
CREATE TABLE wallets (
  id        SERIAL PRIMARY KEY,
  address   TEXT NOT NULL UNIQUE,
  label     TEXT NOT NULL,
  chains    TEXT[] NOT NULL,
  chat_ids  TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE seen_trades (
  key        TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE copy_configs (
  id             SERIAL PRIMARY KEY,
  chat_id        TEXT NOT NULL,
  source_address TEXT NOT NULL,
  source_label   TEXT NOT NULL,
  trading_wallet TEXT NOT NULL,
  quote_currency TEXT NOT NULL DEFAULT 'SOL',
  trade_amount   DOUBLE PRECISION NOT NULL,
  slippage_bps   INTEGER NOT NULL,
  dry_run        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON copy_configs (chat_id, source_address, trading_wallet);

CREATE TABLE positions (
  wallet TEXT NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL,
  qty NUMERIC NOT NULL, cost_usd DOUBLE PRECISION,
  PRIMARY KEY (wallet, chain, token)
);
```

The unique index is on **three** columns deliberately: two people in one chat
mirroring the same trader from different wallets are two valid rows. Keying on
`(chat_id, source_address)` alone makes the second setup silently overwrite the
first.

Run migrations as idempotent `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT
EXISTS` statements at boot.

---

## 11. Build order

Do not reorder. Each step has a definition of done.

1. **Telegram echo bot.** Replies with the chat id. *Done when:* it answers in
   the target chat.
2. **Ingest one chain, log raw transactions.** No parsing. *Done when:* a known
   wallet's activity appears in logs within 2s.
3. **`detect.ts` as a pure function**, tested against recorded transaction
   fixtures — including one airdrop, one rent-funded distribution, and one
   relay-executed buy. *Done when:* those three classify correctly. This is the
   only part that warrants real test coverage, and it is testable offline.
4. **Alerts with price enrichment.** Post immediately, edit in DexScreener data
   when it returns. *Done when:* it has run against real wallets for several
   days and every message has been read critically. Detection bugs surface here
   and nowhere else.
5. **Postgres**: wallets, durable dedupe, chat scoping. *Done when:* restarting
   mid-stream produces no duplicate alerts.
6. **Position tracking and P&L.**
7. **Dry-run copy-trading**: quote, size, render what *would* happen. *Done
   when:* a week of simulated fills has been diffed against what the source
   wallets actually did.
8. **Live execution.** Smallest amount tolerable, one wallet, one source.

Steps 1–7 are roughly a weekend each. Step 8 is where §9 gets extended, one
incident at a time.

---

## 12. Environment

```
TELEGRAM_BOT_TOKEN=
ALERT_CHAT_ID=                      # comma-separated
DATABASE_URL=

TRITON_GRPC_ENDPOINT=               # Solana ingest + RPC
TRITON_GRPC_XTOKEN=
RPC_WS_ETHEREUM=                    # optional, per EVM chain
RPC_WS_BASE=

TRADING_WALLET_PRIVATE_KEY=         # base58, 64 bytes; _2 … _9 for more
OKX_API_KEY=                        # optional: fallback router
OKX_API_SECRET=
OKX_API_PASSPHRASE=
OKX_PROJECT_ID=
```

Validate required variables at boot and fail loudly. Never log a value.

---

## 13. Anti-patterns

Stop if you find yourself doing any of these:

- Adding a program-ID allowlist to detection.
- Writing an in-memory dedupe "for now".
- Calling the submit function from a script, a test, or a setup path.
- Defaulting a new copy config to live because dry-run "was already tested".
- Treating a successful quote as proof a route is sane.
- Catching an error around the submit call and retrying blindly — a timeout does
  not mean the transaction did not land.
- Reading balances without an explicit commitment level.
- Broadening a scope check (chat, wallet, config) to make a bug go away.

---

## 14. Decisions left to the human

Ask rather than assume: which chains, which source wallets, quote currency
(SOL or USDC), per-trade size, slippage tolerance, whether exits are mirrored,
and whether more than one trading wallet is in play.
