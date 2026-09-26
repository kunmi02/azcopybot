# CopyBot

A private, multi-user copy-trading control plane. FOMO is the first identity source, but the engine is wallet-first: once a trader is resolved to a blockchain address, trade detection is done directly on-chain.

This implementation is based on the supplied production implementation spec in `AGENTS.md`, plus the product decisions made for this project:

- 2 private users, each on their own Telegram account.
- One shared Telegram bot; data and trading config are scoped per Telegram user.
- Each user has a separate dedicated copy wallet.
- FOMO handle resolution uses FomoScan, then caches the verified wallet mapping in Postgres.
- Direct Solana wallet following is supported without FomoScan.
- V1 copies **new entries** by default, ignores top-ups by default, and manages exits using the user's TP / SL / max-hold / manual exit rules.
- Every new config starts in **PAPER** mode. Live mode requires explicit confirmation.
- V1 chain monitoring/execution is Solana. EVM wallet identities are stored for the next adapter, but are not executed yet.

## Architecture

```text
                   Web UI                  Telegram Bot
                      |                         |
                      +-----------+-------------+
                                  |
                           TypeScript backend
                                  |
              +-------------------+-------------------+
              |                                       |
        Identity sources                           Control plane
      +-------+---------+                 configs / positions / exits
      |                 |
 FomoScan          Direct wallet
      |                 |
      +---------> Trader + wallets
                        |
                 Solana wallet set
                        |
                 Yellowstone gRPC
                        |
                 raw transaction
                        |
             pure balance-delta detector
                        |
             BUY / FULL EXIT / NEITHER
                        |
                 NEW ENTRY / TOP-UP
                        |
                    Risk/config
                        |
             PAPER or live execution
                        |
                  Jupiter + signer
                        |
                  dedicated wallet
                        |
                 Position manager
                 TP / SL / max hold
```

The source platform is deliberately not inside the execution path. Adding another platform means adding an identity/signal adapter that ultimately produces a wallet or normalized trade event; the risk and position engine stays the same.

## Safety invariants implemented

1. New copy configs default to `dry_run = true`.
2. Live mode requires an explicit confirmation in Telegram or the web API.
3. Signing keys are loaded only from environment variables.
4. The database stores only a `signer_ref`, never a private key.
5. There is one real Solana submission function: `src/execution/submit.ts`.
6. Durable dedupe uses Postgres, not an in-memory set.
7. Solana detection is based on signed balance deltas, not router/program allowlists.
8. Token-account rent is subtracted before SOL outflow is treated as payment.
9. Relay-style receives require a real quote movement and at least $1,000 market liquidity before they can be treated as buys.
10. Live Jupiter output is sanity-checked against DexScreener before signing.
11. The copy wallet must retain at least 0.05 SOL for gas/account creation.
12. Token-2022 transfer-fee mints are currently **refused** in live mode until the OKX fallback adapter has been tested and wired. The bot will not silently use a bad dust-pool route.
13. An unknown/stale watched wallet is dropped rather than broadcast to every user.

## What is implemented

### Identity / trader discovery

- FOMO handle -> FomoScan verified identity, with a confirmation step before the trader is watched.
- Successful FomoScan mappings are cached in Postgres, so the second user following the same FOMO trader does not spend another lookup.
- Direct Solana wallet following.
- One trader record may own multiple wallet records (Solana + EVM).

### Multi-user

- One Telegram bot for both users.
- Users are identified by Telegram numeric user ID/chat ID.
- Separate copy configs, positions, executions and copy wallets.
- Two users can follow the same trader with different trade sizes / TP / SL.
- One shared blockchain subscription monitors a trader once and fans the signal out to every follower.

### Entry detection

The pure detector implements the core rule from `AGENTS.md`:

```text
BUY       = non-quote token increased + quote payment
FULL EXIT = tracked token balance went to zero
NEITHER   = everything else
```

It includes fixtures for:

- normal USDC -> token buy;
- free airdrop;
- rent-funded token distribution;
- relay-style receive requiring a liquidity check.

### Position lifecycle

- New entry vs top-up classification.
- Fixed USD size per copied trade.
- Paper positions and paper exits.
- Live buy/sell execution path for standard SPL tokens through Jupiter.
- Take-profit.
- Stop-loss.
- Maximum hold time.
- Manual 25/50/75/100% exit service (UI currently exposes 50/100; Telegram supports callbacks).
- Optional leader full-exit mirroring (off by default).
- Per-user pause for **new copied entries** while existing TP/SL/max-hold protection stays active.

### Interfaces

- Telegram bot.
- Next.js web dashboard.
- One-time web login codes generated from the user's personal Telegram chat.
- Dashboard shows followed traders, open positions, execution history and copy-wallet status.

## Current V1 boundaries

These are deliberate rather than hidden TODOs:

- **Solana is the live chain in V1.** FomoScan EVM addresses are stored, but Base/BNB/Ethereum watchers/executors are the next chain adapters.
- **OKX fallback is not enabled yet.** Non-zero Token-2022 transfer-fee mints are refused rather than risk an unsafe route.
- The live path is present, but per the supplied implementation spec you should run paper mode against real followed wallets before enabling it with real funds.
- The Yellowstone protobuf normalizer is defensive, but should be verified against the exact Triton/provider payload you subscribe to before live trading.

## Local setup

### 1. Environment

```bash
cp .env.example .env
```

Fill at minimum:

```env
DATABASE_URL=postgres://copybot:copybot@postgres:5432/copybot
TELEGRAM_BOT_TOKEN=...
ALLOWED_TELEGRAM_USER_IDS=123456789,987654321
FOMOSCAN_API_KEY=fsk_live_...
TRITON_GRPC_ENDPOINT=https://...
TRITON_GRPC_XTOKEN=...
SOLANA_RPC_URL=https://...
```

### 2. Dedicated copy wallets

Do not use either person's main wallet. Create a dedicated Solana wallet for each user and fund it with only the amount intended for the bot.

Example binding:

```env
BOOTSTRAP_USERS_JSON=[{"telegramUserId":"123456789","label":"User A","signerRef":"USER_A_SOL","solanaAddress":"USER_A_PUBLIC_KEY"},{"telegramUserId":"987654321","label":"User B","signerRef":"USER_B_SOL","solanaAddress":"USER_B_PUBLIC_KEY"}]

TRADING_WALLET_USER_A_SOL_PRIVATE_KEY=BASE58_64_BYTE_SECRET
TRADING_WALLET_USER_B_SOL_PRIVATE_KEY=BASE58_64_BYTE_SECRET
```

The JSON contains no secret. `signerRef=USER_A_SOL` maps to the environment variable `TRADING_WALLET_USER_A_SOL_PRIVATE_KEY`.

For live trading, each copy wallet should have:

- USDC for trade capital;
- at least 0.05 SOL (0.05-0.1 SOL is the target range) for fees/account creation.

### 3. Run

```bash
docker compose up --build
```

- Web UI: `http://localhost:3000`
- API health: `http://localhost:8080/health`

### 4. Telegram onboarding

Each allowlisted user opens the same bot and sends:

```text
/start
```

Then:

```text
/follow @fomo_handle
```

or use the web UI. `/login` creates a one-time web login code valid for 5 minutes.

Useful commands:

```text
/follow @handle
/following
/unfollow <config-id>
/positions
/wallet
/login
/pause
/resume
/live <config-id>
/paper <config-id>
```

`/live` always presents an explicit second confirmation before the config is changed. It also refuses live mode unless a Jupiter API key is configured and the environment-held signer resolves to the exact configured copy-wallet public address.

## FomoScan credit usage

FomoScan is used for identity resolution, not trade streaming:

```text
@handle -> FomoScan -> verified SOL/EVM address -> Postgres cache
                                        |
                                        +-> Yellowstone watches SOL directly
```

If User B follows a FOMO trader already resolved by User A, the cached trader/wallet is reused. This is intentional so the free/paid FomoScan allowance is not burned on every trade.

## Coolify / Contabo

The simplest production layout is three services on one VPS:

```text
Postgres
Backend (API + Telegram + trading worker)
Web (Next.js)
```

The backend is long-lived and must not scale to zero because it holds the Yellowstone stream and the position monitor.

See `COOLIFY.md` for deployment steps.

## Tests

After dependencies are installed:

```bash
npm test
npm run typecheck
```

The pure detection fixtures should be expanded with **recorded real transactions from the exact traders you intend to copy** before live mode is enabled.

## Validation already performed on this snapshot

- All TypeScript/TSX source files pass a syntax transpilation check.
- The pure detection suite passes all 4 included fixtures: normal buy, free airdrop, rent-funded distribution, and relay-style receive.
- A static audit confirms that the only Solana `sendTransaction` call is in `src/execution/submit.ts`.
- A static audit confirms signing-key environment access is isolated to `src/wallet.ts`.

A full dependency-backed `npm install && npm run typecheck` could not be completed in the generation environment because package installation timed out. Run those commands in CI or locally before deployment; do not enable LIVE mode until they pass and the real Yellowstone payload has been validated.

## Next implementation milestones

1. Run Yellowstone against one known Solana wallet and save recorded transaction fixtures.
2. Validate the protobuf normalizer against those real messages.
3. Run Telegram alerts for several days with no execution.
4. Paper-copy entries for at least a week and compare entry latency/fills with the manual workflow.
5. Implement/test OKX fallback for Token-2022 transfer-fee tokens.
6. Enable the smallest tolerable live amount on one user + one trader.
7. Add the EVM chain adapter (Base first), while keeping the same source/risk/position interfaces.
