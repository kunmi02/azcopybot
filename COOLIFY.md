# Deploying CopyBot on Contabo + Coolify

## Recommended V1 layout

One VPS is enough for the two-user private deployment:

- Coolify
- Postgres
- `copybot-backend`
- `copybot-web`

The trading backend is long-lived. Disable scale-to-zero/sleep and use an `unless-stopped`/always restart policy.

## 1. Server

Provision the VPS, install Docker and Coolify, then point a domain at the server. Suggested domains:

```text
copy.example.com      -> Next.js web
copy-api.example.com  -> backend API
```

## 2. Postgres

Create a persistent Postgres 16 service in Coolify. Keep it private to the Docker network. Create a database and set the resulting private connection string as `DATABASE_URL` on the backend.

Configure an off-server backup target (S3-compatible storage is fine). At minimum retain daily backups. The database contains open positions, durable dedupe state, trader mappings and user configs.

## 3. Backend service

Repository root build context, Dockerfile:

```text
apps/backend/Dockerfile
```

Expose port `8080` and bind the API domain.

Set all backend environment variables from `.env.example`.

Important secrets:

- `TELEGRAM_BOT_TOKEN`
- `FOMOSCAN_API_KEY`
- `TRITON_GRPC_XTOKEN`
- `TRADING_WALLET_<SIGNER_REF>_PRIVATE_KEY`

Never put signing keys in Postgres or the web service.

## 4. Web service

Repository root build context, Dockerfile:

```text
apps/web/Dockerfile
```

Build argument / environment:

```env
NEXT_PUBLIC_API_URL=https://copy-api.example.com
```

Set backend:

```env
PUBLIC_APP_URL=https://copy.example.com
```

This allows CORS only from the dashboard origin.

## 5. Telegram

Create one BotFather bot. Both private users talk to that same bot from their personal Telegram accounts. Put both numeric Telegram user IDs in:

```env
ALLOWED_TELEGRAM_USER_IDS=111111111,222222222
```

The bot scopes every config/position to the user's Telegram identity.

## 6. Copy wallets

Bind each allowlisted Telegram user to a dedicated Solana copy wallet through `BOOTSTRAP_USERS_JSON`, and provide each private key as its own backend-only environment variable.

Start with paper mode. Do not enable live mode just because the deployment is healthy.

## 7. Health / operations

Backend health endpoint:

```text
GET /health
```

Add uptime monitoring for the API and alerts for backend restarts. The app logs:

- watcher reconfiguration;
- stream errors/end/close;
- position evaluation failures;
- failed copy execution.

Before meaningful funds are used, add structured error reporting and external Postgres backups.
