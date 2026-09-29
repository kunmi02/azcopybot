import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  clearSessionCookie,
  getSessionToken,
  randomSessionToken,
  requireUser,
  sessionCookie,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import type { TraderService } from "./services/traders.js";
import type { PositionService } from "./services/positions.js";
import type { DexScreenerPriceService } from "./services/pricing.js";
import type { SolanaRpc } from "./chains/solana/rpc.js";
import { SOLANA_USDC } from "./execution/solana.js";
import { loadSolanaSigner } from "./wallet.js";
import type { ActivityService } from "./services/activity.js";
import type { HealthService } from "./services/health.js";
import type { RetryExecutionService } from "./services/retry.js";
import type { SourcingService } from "./services/sourcing.js";

export async function buildApi(
  config: AppConfig,
  db: Database,
  traders: TraderService,
  positions: PositionService,
  prices: DexScreenerPriceService,
  rpc: SolanaRpc,
  activity: ActivityService,
  health: HealthService,
  retryExecutions: RetryExecutionService,
  sourcing: SourcingService,
) {
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: config.PUBLIC_APP_URL,
    credentials: true,
    allowedHeaders: ["content-type"],
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
    const bucket =
      !current || current.resetAt <= now
        ? { count: 0, resetAt: now + 60_000 }
        : current;
    bucket.count += 1;
    loginAttempts.set(key, bucket);
    if (bucket.count > 10)
      return reply.status(429).send({ error: "TOO_MANY_LOGIN_ATTEMPTS" });
    const code = String((req.body as any)?.code ?? "").trim();
    if (!/^\d{6}$/.test(code))
      return reply.status(400).send({ error: "INVALID_CODE" });
    const userId = await db.consumeLoginCode(code);
    if (!userId)
      return reply.status(401).send({ error: "CODE_EXPIRED_OR_INVALID" });
    const token = randomSessionToken();
    await db.createWebSession(
      userId,
      token,
      new Date(Date.now() + 30 * 24 * 60 * 60_000),
    );
    reply.header(
      "set-cookie",
      sessionCookie(token, shouldUseSecureCookies(config)),
    );
    return { ok: true };
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = getSessionToken(req);
    if (token) await db.deleteSession(token);
    reply.header(
      "set-cookie",
      clearSessionCookie(shouldUseSecureCookies(config)),
    );
    return { ok: true };
  });

  app.get("/api/me", async (req) => ({
    user: publicUser(await requireUser(req, db)),
  }));
  app.get("/api/dashboard", async (req) => {
    const user = await requireUser(req, db);
    const dashboard = await db.dashboard(user.id);
    const enrichedPositions = await Promise.all(
      dashboard.positions.map(async (p: any) => {
        const market = await prices.getTokenMarket(p.token).catch(() => null);
        if (!market)
          return {
            ...p,
            current_price: null,
            current_value_usd: null,
            pnl_pct: null,
            symbol: null,
          };
        const currentValue = Number(p.qty) * market.priceUsd;
        const pnlPct =
          Number(p.cost_usd) > 0
            ? ((currentValue - Number(p.cost_usd)) / Number(p.cost_usd)) * 100
            : 0;
        return {
          ...p,
          current_price: market.priceUsd,
          current_value_usd: currentValue,
          pnl_pct: pnlPct,
          symbol: market.symbol ?? null,
        };
      }),
    );
    let walletBalances = null;
    let walletReadiness = {
      copyWallet: Boolean(dashboard.wallet?.public_address),
      signer: false,
      jupiter: Boolean(config.JUPITER_API_KEY),
      solReserve: false,
      usdcBalance: false,
    };
    if (dashboard.wallet?.public_address) {
      const [solLamports, usdcRaw] = await Promise.all([
        rpc.solBalance(dashboard.wallet.public_address).catch(() => null),
        rpc
          .tokenBalanceRaw(dashboard.wallet.public_address, SOLANA_USDC)
          .catch(() => null),
      ]);
      walletBalances = {
        sol: solLamports == null ? null : Number(solLamports) / 1e9,
        usdc: usdcRaw == null ? null : Number(usdcRaw) / 1e6,
      };
      try {
        const signer = loadSolanaSigner(dashboard.wallet.signer_ref);
        walletReadiness.signer =
          signer.publicKey.toBase58() === dashboard.wallet.public_address;
      } catch {
        walletReadiness.signer = false;
      }
      walletReadiness.solReserve =
        solLamports != null && solLamports >= 50_000_000n;
      walletReadiness.usdcBalance = usdcRaw != null && usdcRaw > 0n;
    }
    return publicDashboard({
      ...dashboard,
      positions: enrichedPositions,
      walletBalances,
      walletReadiness,
    });
  });

  app.get("/api/activity", async (req) => {
    const user = await requireUser(req, db);
    const limit = Number((req.query as any)?.limit ?? 100);
    const events = await db.listActivityEvents(
      user.id,
      Math.max(1, Math.min(200, limit)),
    );
    return { events: events.map(publicActivityEvent) };
  });

  app.get("/api/events", async (req, reply) => {
    const user = await requireUserFromHeaderOrQuery(req, db);
    reply.hijack();
    app.log.info({ userId: user.id }, "activity_stream_connected");
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": config.PUBLIC_APP_URL,
      "access-control-allow-credentials": "true",
      vary: "origin",
    });
    const write = (payload: string) => {
      if (!reply.raw.destroyed) reply.raw.write(payload);
    };
    write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    const unsubscribe = activity.subscribe(user.id, (event) => {
      write(
        `event: activity\ndata: ${JSON.stringify(publicActivityEvent(event))}\n\n`,
      );
    });
    const keepAlive = setInterval(() => write(": keepalive\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      app.log.info({ userId: user.id }, "activity_stream_closed");
    });
  });

  app.get("/api/sourcing/feed", async (req) => {
    await requireUser(req, db);
    return sourcing.feed();
  });

  app.post("/api/sourcing/candidates/best", async (req) => {
    await requireUser(req, db);
    return sourcing.bestCandidates(5);
  });

  app.get("/api/sourcing/candidates/:id", async (req) => {
    await requireUser(req, db);
    return sourcing.candidateDetail((req.params as any).id as string);
  });

  app.post("/api/sourcing/candidates/:id/analyze", async (req) => {
    await requireUser(req, db);
    return sourcing.analyzeCandidate((req.params as any).id as string);
  });

  app.post("/api/sourcing/tokens/:mint/discover", async (req) => {
    await requireUser(req, db);
    const body = req.body as any;
    return sourcing.discoverWinningToken({
      mint: (req.params as any).mint as string,
      peakMultiple:
        body?.peakMultiple == null || body.peakMultiple === ""
          ? null
          : Number(body.peakMultiple),
      maxBuyers: body?.maxBuyers == null ? 100 : Number(body.maxBuyers),
      minTradeUsd: body?.minTradeUsd == null ? 10 : Number(body.minTradeUsd),
    });
  });

  app.post("/api/sourcing/scan", async (req) => {
    await requireUser(req, db);
    return sourcing.scanTrendingTokens({
      maxTokens: config.SOURCING_SCAN_MAX_TOKENS,
      minLiquidityUsd: config.SOURCING_MIN_LIQUIDITY_USD,
      minVolumeH1Usd: config.SOURCING_MIN_VOLUME_H1_USD,
      minTxnsH1: config.SOURCING_MIN_TXNS_H1,
      minAgeMinutes: config.SOURCING_MIN_AGE_MINUTES,
      maxAgeHours: config.SOURCING_MAX_AGE_HOURS,
      minPeakMultiple: config.SOURCING_MIN_PEAK_MULTIPLE,
    });
  });

  app.get("/api/system-health", async (req) => {
    await requireUser(req, db);
    const rpcStarted = Date.now();
    const rpcResult = await rpc
      .call("getSlot", [{ commitment: "processed" }])
      .then(
        (slot) => ({
          state: "healthy",
          slot,
          latencyMs: Date.now() - rpcStarted,
        }),
        (error) => ({
          state: "down",
          error: String(error).slice(0, 180),
          latencyMs: Date.now() - rpcStarted,
        }),
      );
    return {
      ...health.snapshot(),
      solanaRpc: rpcResult,
      jupiter: {
        state: config.JUPITER_API_KEY ? "configured" : "missing_api_key",
        baseUrl: config.JUPITER_API_BASE,
      },
      fomoScan: {
        state: config.FOMOSCAN_API_KEY ? "configured" : "missing_api_key",
        baseUrl: config.FOMOSCAN_API_BASE,
      },
    };
  });
  app.get("/api/traders", async (req) => {
    const user = await requireUser(req, db);
    return (await db.listUserTraders(user.id)).map(publicTrader);
  });
  app.get("/api/positions", async (req) => {
    const user = await requireUser(req, db);
    return (await db.listOpenPositions(user.id)).map(publicPosition);
  });
  app.get("/api/executions", async (req) => {
    const user = await requireUser(req, db);
    return (await db.listExecutions(user.id, 100)).map(publicExecution);
  });

  app.post("/api/executions/:id/retry", async (req) => {
    const user = await requireUser(req, db);
    const id = (req.params as any).id as string;
    return retryExecutions.retry(user.id, id);
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
      await traders.followFomo(user.id, handle);
      return { ok: true };
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
    await traders.followWallet(user.id, {
      label: String(body?.label ?? "Wallet trader"),
      chain: String(body?.chain ?? "solana"),
      address: String(body?.address ?? ""),
    });
    return { ok: true };
  });

  app.patch("/api/configs/:id", async (req, reply) => {
    const user = await requireUser(req, db);
    const body = req.body as any;
    const id = (req.params as any).id as string;
    if (body?.dryRun === false && body?.confirmLive !== true) {
      return reply
        .status(400)
        .send({ error: "LIVE_REQUIRES_EXPLICIT_CONFIRMATION" });
    }
    if (body?.dryRun === false) {
      const error = await assertLiveReady(config, db, user.id);
      if (error) return reply.status(400).send({ error });
    }
    const patch = { ...body };
    delete patch.confirmLive;
    await traders.updateConfig(user.id, id, patch);
    return { ok: true };
  });

  app.post("/api/trading/live-all", async (req, reply) => {
    const user = await requireUser(req, db);
    if ((req.body as any)?.confirmLive !== true)
      return reply
        .status(400)
        .send({ error: "LIVE_REQUIRES_EXPLICIT_CONFIRMATION" });
    const error = await assertLiveReady(config, db, user.id);
    if (error) return reply.status(400).send({ error });
    const updated = await db.setAllCopyConfigsMode(user.id, false);
    await activity.emit({
      userId: user.id,
      type: "all_configs_live_enabled",
      severity: "warning",
      message: `LIVE mode enabled for ${updated} followed trader${updated === 1 ? "" : "s"}.`,
      metadata: { updated },
    });
    return { ok: true, updated };
  });

  app.post("/api/trading/paper-all", async (req) => {
    const user = await requireUser(req, db);
    const updated = await db.setAllCopyConfigsMode(user.id, true);
    await activity.emit({
      userId: user.id,
      type: "all_configs_paper_enabled",
      message: `Paper mode enabled for ${updated} followed trader${updated === 1 ? "" : "s"}. Existing live positions remain real.`,
      metadata: { updated },
    });
    return { ok: true, updated };
  });

  app.post("/api/positions/:id/convert-live", async (req, reply) => {
    const user = await requireUser(req, db);
    if ((req.body as any)?.confirmLive !== true) {
      return reply
        .status(400)
        .send({ error: "LIVE_REQUIRES_EXPLICIT_CONFIRMATION" });
    }
    const error = await assertLiveReady(config, db, user.id);
    if (error) return reply.status(400).send({ error });
    const id = (req.params as any).id as string;
    return positions.convertPaperToLive(user.id, id);
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

async function requireUserFromHeaderOrQuery(request: any, db: Database) {
  return requireUser(request, db);
}

function fomoScanHttpError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode =
    message === "FOMOSCAN_API_KEY_NOT_CONFIGURED"
      ? 400
      : message.startsWith("FOMOSCAN_NOT_OBSERVED:")
        ? 404
        : message === "FOMOSCAN_QUOTA_EXCEEDED"
          ? 402
          : message === "FOMOSCAN_RATE_LIMITED"
            ? 429
            : message.startsWith("FOMOSCAN_HTTP_401") ||
                message.startsWith("FOMOSCAN_HTTP_403")
              ? 401
              : message === "FOMO handle is required"
                ? 400
                : 500;
  return Object.assign(new Error(message), { statusCode });
}

async function assertLiveReady(
  config: AppConfig,
  db: Database,
  userId: string,
) {
  const wallet = await db.getCopyWallet(userId, "solana");
  if (!wallet) return "COPY_WALLET_NOT_CONFIGURED";
  if (!config.JUPITER_API_KEY) return "JUPITER_API_KEY_REQUIRED_FOR_LIVE";
  try {
    const signer = loadSolanaSigner(wallet.signer_ref);
    if (signer.publicKey.toBase58() !== wallet.public_address)
      throw new Error("SIGNER_PUBLIC_KEY_MISMATCH");
  } catch (error) {
    return `LIVE_SIGNER_NOT_READY:${String(error)}`;
  }
  return null;
}

function shouldUseSecureCookies(config: AppConfig) {
  return (
    config.NODE_ENV === "production" &&
    config.PUBLIC_APP_URL.startsWith("https://")
  );
}

function publicDashboard(dashboard: any) {
  return {
    user: publicUser(dashboard.user),
    wallet: publicWallet(dashboard.wallet),
    positions: (dashboard.positions ?? []).map(publicPosition),
    traders: (dashboard.traders ?? []).map(publicTrader),
    inactiveTraders: (dashboard.inactiveTraders ?? []).map(publicTrader),
    executions: (dashboard.executions ?? []).map(publicExecution),
    activity: (dashboard.activity ?? []).map(publicActivityEvent),
    walletBalances: dashboard.walletBalances ?? null,
    walletReadiness: dashboard.walletReadiness ?? null,
  };
}

function publicUser(user: any) {
  return {
    display_name: user?.display_name ?? "",
    paused: Boolean(user?.paused),
  };
}

function publicWallet(wallet: any) {
  if (!wallet) return null;
  return {
    configured: true,
    chain: wallet.chain,
    display_address: maskAddress(wallet.public_address),
  };
}

function publicTrader(trader: any) {
  return {
    config_id: trader.config_id,
    trader_id: trader.trader_id,
    handle: trader.handle,
    display_name: trader.display_name,
    source: trader.source,
    wallets: Array.isArray(trader.wallets)
      ? trader.wallets.map((wallet: any) => ({
          chain: wallet.chain,
          address: wallet.address,
        }))
      : [],
    trade_amount_usd: trader.trade_amount_usd,
    slippage_bps: trader.slippage_bps,
    copy_new_entries: trader.copy_new_entries,
    copy_topups: trader.copy_topups,
    mirror_exits: trader.mirror_exits,
    take_profit_pct: trader.take_profit_pct,
    stop_loss_pct: trader.stop_loss_pct,
    max_hold_seconds: trader.max_hold_seconds,
    dry_run: trader.dry_run,
    enabled: trader.enabled,
    created_at: trader.created_at,
  };
}

function publicPosition(position: any) {
  return {
    id: position.id,
    trader_id: position.trader_id,
    chain: position.chain,
    token: position.token,
    qty: position.qty,
    cost_usd: position.cost_usd,
    avg_entry_price: position.avg_entry_price,
    highest_price: position.highest_price,
    mode: position.mode,
    status: position.status,
    opened_at: position.opened_at,
    closed_at: position.closed_at,
    handle: position.handle,
    display_name: position.display_name,
    take_profit_pct: position.take_profit_pct,
    stop_loss_pct: position.stop_loss_pct,
    max_hold_seconds: position.max_hold_seconds,
    dry_run: position.dry_run,
    slippage_bps: position.slippage_bps,
    current_price: position.current_price,
    current_value_usd: position.current_value_usd,
    pnl_pct: position.pnl_pct,
    symbol: position.symbol,
  };
}

function publicExecution(execution: any) {
  return {
    id: execution.id,
    trader_id: execution.trader_id,
    source_tx_hash: execution.source_tx_hash,
    chain: execution.chain,
    token: execution.token,
    side: execution.side,
    reason: execution.reason,
    requested_usd: execution.requested_usd,
    actual_usd: execution.actual_usd,
    token_qty: execution.token_qty,
    execution_price: execution.execution_price,
    tx_hash: execution.tx_hash,
    status: execution.status,
    created_at: execution.created_at,
    confirmed_at: execution.confirmed_at,
    handle: execution.handle,
    display_name: execution.display_name,
  };
}

function publicActivityEvent(event: any) {
  return {
    id: event.id,
    trader_id: event.trader_id ?? event.traderId ?? null,
    type: event.type,
    severity: event.severity,
    message: event.message,
    metadata: event.metadata ?? {},
    created_at: event.created_at,
    handle: event.handle,
    display_name: event.display_name,
  };
}

function maskAddress(address: string | null | undefined) {
  if (!address) return "";
  return address.length <= 12
    ? address
    : address.slice(0, 5) + "…" + address.slice(-5);
}
