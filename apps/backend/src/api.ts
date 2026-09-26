import Fastify from "fastify";
import cors from "@fastify/cors";
import { randomSessionToken, requireUser } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import type { TraderService } from "./services/traders.js";
import type { PositionService } from "./services/positions.js";
import type { DexScreenerPriceService } from "./services/pricing.js";
import type { SolanaRpc } from "./chains/solana/rpc.js";
import { SOLANA_USDC } from "./execution/solana.js";
import { loadSolanaSigner } from "./wallet.js";

export async function buildApi(
  config: AppConfig,
  db: Database,
  traders: TraderService,
  positions: PositionService,
  prices: DexScreenerPriceService,
  rpc: SolanaRpc,
) {
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: config.PUBLIC_APP_URL,
    credentials: false,
    allowedHeaders: ["content-type", "authorization"],
  });

  app.setErrorHandler((error, _req, reply) => {
    const status = (error as any).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    reply.status(status).send({ error: message });
  });

  app.get("/health", async () => ({ ok: true }));

  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  app.post("/auth/code", async (req, reply) => {
    const now = Date.now();
    const key = req.ip;
    const current = loginAttempts.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
    bucket.count += 1; loginAttempts.set(key, bucket);
    if (bucket.count > 10) return reply.status(429).send({ error: "TOO_MANY_LOGIN_ATTEMPTS" });
    const code = String((req.body as any)?.code ?? "").trim();
    if (!/^\d{6}$/.test(code)) return reply.status(400).send({ error: "INVALID_CODE" });
    const userId = await db.consumeLoginCode(code);
    if (!userId) return reply.status(401).send({ error: "CODE_EXPIRED_OR_INVALID" });
    const token = randomSessionToken();
    await db.createWebSession(userId, token, new Date(Date.now() + 30 * 24 * 60 * 60_000));
    return { token };
  });

  app.get("/api/me", async (req) => ({ user: await requireUser(req, db) }));
  app.get("/api/dashboard", async (req) => {
    const user = await requireUser(req, db);
    const dashboard = await db.dashboard(user.id);
    const enrichedPositions = await Promise.all(dashboard.positions.map(async (p: any) => {
      const market = await prices.getTokenMarket(p.token).catch(() => null);
      if (!market) return { ...p, current_price: null, current_value_usd: null, pnl_pct: null, symbol: null };
      const currentValue = Number(p.qty) * market.priceUsd;
      const pnlPct = Number(p.cost_usd) > 0 ? ((currentValue - Number(p.cost_usd)) / Number(p.cost_usd)) * 100 : 0;
      return { ...p, current_price: market.priceUsd, current_value_usd: currentValue, pnl_pct: pnlPct, symbol: market.symbol ?? null };
    }));
    let walletBalances = null;
    if (dashboard.wallet?.public_address) {
      const [solLamports, usdcRaw] = await Promise.all([
        rpc.solBalance(dashboard.wallet.public_address).catch(() => null),
        rpc.tokenBalanceRaw(dashboard.wallet.public_address, SOLANA_USDC).catch(() => null),
      ]);
      walletBalances = {
        sol: solLamports == null ? null : Number(solLamports) / 1e9,
        usdc: usdcRaw == null ? null : Number(usdcRaw) / 1e6,
      };
    }
    return { ...dashboard, positions: enrichedPositions, walletBalances };
  });
  app.get("/api/traders", async (req) => {
    const user = await requireUser(req, db);
    return db.listUserTraders(user.id);
  });
  app.get("/api/positions", async (req) => {
    const user = await requireUser(req, db);
    return db.listOpenPositions(user.id);
  });
  app.get("/api/executions", async (req) => {
    const user = await requireUser(req, db);
    return db.listExecutions(user.id, 100);
  });


  app.post("/api/traders/fomo/resolve", async (req) => {
    await requireUser(req, db);
    const handle = String((req.body as any)?.handle ?? "").trim();
    try {
      return await traders.resolveFomo(handle);
    } catch (error) {
      throw fomoScanHttpError(error);
    }
  });

  app.post("/api/traders/fomo", async (req) => {
    const user = await requireUser(req, db);
    const handle = String((req.body as any)?.handle ?? "").trim();
    try {
      return await traders.followFomo(user.id, handle);
    } catch (error) {
      throw fomoScanHttpError(error);
    }
  });

  app.delete("/api/configs/:id", async (req) => {
    const user = await requireUser(req, db);
    const id = (req.params as any).id as string;
    return traders.unfollow(user.id, id);
  });

  app.post("/api/traders/wallet", async (req) => {
    const user = await requireUser(req, db);
    const body = req.body as any;
    return traders.followWallet(user.id, {
      label: String(body?.label ?? "Wallet trader"),
      chain: String(body?.chain ?? "solana"),
      address: String(body?.address ?? ""),
    });
  });

  app.patch("/api/configs/:id", async (req, reply) => {
    const user = await requireUser(req, db);
    const body = req.body as any;
    const id = (req.params as any).id as string;
    if (body?.dryRun === false && body?.confirmLive !== true) {
      return reply.status(400).send({ error: "LIVE_REQUIRES_EXPLICIT_CONFIRMATION" });
    }
    if (body?.dryRun === false) {
      const wallet = await db.getCopyWallet(user.id, "solana");
      if (!wallet) return reply.status(400).send({ error: "COPY_WALLET_NOT_CONFIGURED" });
      if (!config.JUPITER_API_KEY) return reply.status(400).send({ error: "JUPITER_API_KEY_REQUIRED_FOR_LIVE" });
      try {
        const signer = loadSolanaSigner(wallet.signer_ref);
        if (signer.publicKey.toBase58() !== wallet.public_address) throw new Error("SIGNER_PUBLIC_KEY_MISMATCH");
      } catch (error) {
        return reply.status(400).send({ error: `LIVE_SIGNER_NOT_READY:${String(error)}` });
      }
    }
    const patch = { ...body };
    delete patch.confirmLive;
    return db.updateCopyConfig(user.id, id, patch);
  });

  app.post("/api/positions/:id/exit", async (req) => {
    const user = await requireUser(req, db);
    const id = (req.params as any).id as string;
    const percentage = Number((req.body as any)?.percentage ?? 100);
    await positions.exit(user.id, id, percentage, "MANUAL_EXIT");
    return { ok: true };
  });

  app.post("/api/trading/pause", async (req) => {
    const user = await requireUser(req, db);
    await db.setUserPaused(user.id, true);
    return { ok: true };
  });

  app.post("/api/trading/resume", async (req) => {
    const user = await requireUser(req, db);
    await db.setUserPaused(user.id, false);
    return { ok: true };
  });

  return app;
}

function fomoScanHttpError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode =
    message === "FOMOSCAN_API_KEY_NOT_CONFIGURED" ? 400 :
    message.startsWith("FOMOSCAN_NOT_OBSERVED:") ? 404 :
    message === "FOMOSCAN_QUOTA_EXCEEDED" ? 402 :
    message === "FOMOSCAN_RATE_LIMITED" ? 429 :
    message.startsWith("FOMOSCAN_HTTP_401") || message.startsWith("FOMOSCAN_HTTP_403") ? 401 :
    message === "FOMO handle is required" ? 400 :
    500;
  return Object.assign(new Error(message), { statusCode });
}
