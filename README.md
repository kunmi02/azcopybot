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
- Read-only trader discovery from early buyers of winning tokens.

## Current V1 boundaries

These are deliberate rather than hidden TODOs:

- **Solana is the live chain in V1.** FomoScan EVM addresses are stored, but Base/BNB/Ethereum watchers/executors are the next chain adapters.
- **OKX fallback is not enabled yet.** Non-zero Token-2022 transfer-fee mints are refused rather than risk an unsafe route.
- The live path is present, but per the supplied implementation spec you should run paper mode against real followed wallets before enabling it with real funds.
- The Yellowstone protobuf normalizer is defensive, but should be verified against the exact Triton/provider payload you subscribe to before live trading.

## Local setup

### 1. Prerequisites

Use Node 22 locally. The Docker images also use Node 22, and some dependencies warn or fail on older Node versions.

```bash
node -v
```

If needed, switch with `nvm`:

```bash
nvm install 22
nvm use 22
```

Install workspace dependencies from the repo root:

```bash
npm install
```

If your editor shows errors such as `Cannot find module 'grammy' or its corresponding type declarations`, dependencies have not been installed in the workspace yet, or the editor TypeScript server needs to be restarted after `npm install`.

### 2. Environment

```bash
cp .env.example .env
```

Fill at minimum. If you run the full app with Docker Compose, use the Compose service hostname for Postgres:

```env
DATABASE_URL=postgres://copybot:copybot@postgres:5432/copybot
TELEGRAM_BOT_TOKEN=...
ALLOWED_TELEGRAM_USER_IDS=123456789,987654321
FOMOSCAN_API_KEY=fsk_live_...
TRITON_GRPC_ENDPOINT=https://...
TRITON_GRPC_XTOKEN=...
SOLANA_RPC_URL=https://...
HELIUS_API_KEY=...                  # optional, enables Trader Discovery early-buyer sourcing
SOURCING_AUTO_DISCOVERY_ENABLED=true
```

If you run the backend directly on your machine while only Postgres is running in Docker, use localhost instead:

```env
DATABASE_URL=postgres://copybot:copybot@localhost:5432/copybot
```

### 3. Dedicated copy wallets

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

### 4. Run with Docker Compose

This starts Postgres, the backend API/Telegram worker, and the web app:

```bash
docker compose up --build
```

- Web UI: `http://localhost:3000`
- API health: `http://localhost:8080/health`

### 5. Run in local dev mode

For faster local iteration, start Postgres in Docker:

```bash
docker compose up postgres
```

Then start the backend and web app in separate terminals:

```bash
npm run dev:backend
```

```bash
npm run dev:web
```

The backend listens on `http://localhost:8080`; the web app listens on `http://localhost:3000`.

The backend dev/start scripts load the repo-root `.env` file automatically. If you run `tsx` manually from `apps/backend`, include the env file yourself:

```bash
npx tsx --env-file=../../.env src/index.ts
```

### 6. Verify the setup

Run the typechecker and tests from the repo root:

```bash
npm run typecheck
npm test
```

`npm audit fix --force` is not part of normal local setup. It can introduce breaking dependency changes; review audit output deliberately before changing dependency versions.

### 7. Telegram onboarding

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

### 8. Trader Discovery / wallet sourcing

The dashboard includes a **Trader Discovery** section for automated wallet sourcing:

```text
DexScreener Solana discovery -> liquidity/volume/momentum filters -> early buyers -> candidate wallets -> priority score
```

This feature is read-only. It stores candidate wallets and evidence, but it does not follow a wallet, enable live mode, or place trades automatically.

To enable it, add a Helius API key:

```env
HELIUS_API_KEY=...
HELIUS_API_BASE=https://api.helius.xyz/v0
SOURCING_AUTO_DISCOVERY_ENABLED=true
SOURCING_SCAN_INTERVAL_MS=600000
SOURCING_SCAN_MAX_TOKENS=3
SOURCING_MIN_LIQUIDITY_USD=10000
SOURCING_MIN_VOLUME_H1_USD=5000
SOURCING_MIN_TXNS_H1=25
SOURCING_MIN_AGE_MINUTES=5
SOURCING_MAX_AGE_HOURS=48
SOURCING_MIN_PEAK_MULTIPLE=2
```

Then restart the backend so the sourcing tables are migrated. The backend will scan automatically after startup and then on the configured interval. The web UI also has **Scan now** for immediate runs.

Manual token input remains available for tokens you already know. Candidates are ranked higher when they appear early across multiple winning tokens.

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

- `npm run typecheck` passes for backend and web.
- `npm test` passes the pure detection fixtures: normal buy, free airdrop, rent-funded distribution, relay-style receive, partial sell, and full sell.
- A static audit confirms that the only Solana `sendTransaction` call is in `src/execution/submit.ts`.
- A static audit confirms signing-key environment access is isolated to `src/wallet.ts`.

## Next implementation milestones

1. Run Yellowstone against one known Solana wallet and save recorded transaction fixtures.
2. Validate the protobuf normalizer against those real messages.
3. Run Telegram alerts for several days with no execution.
4. Paper-copy entries for at least a week and compare entry latency/fills with the manual workflow.
5. Implement/test OKX fallback for Token-2022 transfer-fee tokens.
6. Enable the smallest tolerable live amount on one user + one trader.
7. Add the EVM chain adapter (Base first), while keeping the same source/risk/position interfaces.
