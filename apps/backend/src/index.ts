import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { FomoScanClient } from "./sources/fomoscan.js";
import { DexScreenerPriceService } from "./services/pricing.js";
import { SolanaRpc } from "./chains/solana/rpc.js";
import { JupiterClient } from "./execution/jupiter.js";
import { OkxRouter } from "./execution/okx.js";
import { SolanaExecutor } from "./execution/solana.js";
import { SolanaGrpcWatcher } from "./chains/solana/grpc.js";
import { CopyTradeService } from "./services/copytrade.js";
import { PositionService } from "./services/positions.js";
import { TradingEngine } from "./services/engine.js";
import { TraderService } from "./services/traders.js";
import { TelegramController } from "./telegram.js";
import { buildApi } from "./api.js";
import { SubmissionReconciler } from "./services/reconcile.js";
import { ActivityService } from "./services/activity.js";
import { HealthService } from "./services/health.js";
import { RetryExecutionService } from "./services/retry.js";
import { SourcingService } from "./services/sourcing.js";
import { AutoTradingService } from "./services/auto-trading.js";
import { MarketSignalService } from "./services/market-signals.js";
import {
  HeliusEarlyBuyerSource,
  NoopEarlyBuyerSource,
} from "./sources/helius.js";

const config = loadConfig();
const db = new Database(config.DATABASE_URL);
await db.migrate();

// Ensure allowlisted Telegram users exist only after they start the bot; bootstrap only copy-wallet bindings.
for (const item of config.bootstrapUsers) {
  const user = await db.getUserByTelegramId(item.telegramUserId);
  if (user)
    await db.upsertCopyWallet(
      user.id,
      "solana",
      item.solanaAddress,
      item.signerRef,
    );
}

const prices = new DexScreenerPriceService();
const earlyBuyerSource = config.HELIUS_API_KEY
  ? new HeliusEarlyBuyerSource(config.HELIUS_API_BASE, config.HELIUS_API_KEY)
  : new NoopEarlyBuyerSource();
const rpc = new SolanaRpc(config.SOLANA_RPC_URL);
const jupiter = new JupiterClient(
  config.JUPITER_API_BASE,
  config.JUPITER_API_KEY,
);
const okx = new OkxRouter(
  config.OKX_API_BASE,
  config.OKX_API_KEY,
  config.OKX_API_SECRET,
  config.OKX_API_PASSPHRASE,
  config.OKX_PROJECT_ID,
);
const executor = new SolanaExecutor(
  rpc,
  jupiter,
  prices,
  okx,
  config.TOKEN_2022_FALLBACK_ENABLED,
);
const activity = new ActivityService(db);
const health = new HealthService();

let watched = new Set<string>();
let telegram!: TelegramController;
let engine!: TradingEngine;
const watcher = new SolanaGrpcWatcher(
  config.TRITON_GRPC_ENDPOINT,
  config.TRITON_GRPC_XTOKEN,
  async (snapshot) => {
    await engine.processSnapshot(snapshot);
  },
);

async function refreshWatchers() {
  watched = new Set(await db.listSolanaWatchedAddresses());
  health.setWatchedWallets(watched.size);
  health.markTriton(watched.size ? "healthy" : "unknown");
  await watcher.reconfigure([...watched]);
  console.log("watcher_reconfigured", { wallets: watched.size });
}

// Temporary notify closure is safe because telegram is assigned before any stream is started.
const notify = async (
  chatId: string,
  text: string,
  buttons?: Array<Array<{ text: string; callback_data: string }>>,
) => {
  await telegram.notify(chatId, text, buttons);
};

const positions = new PositionService(db, prices, executor, notify, activity);
const copyTrade = new CopyTradeService(db, prices, executor, notify, activity);
const retryExecutions = new RetryExecutionService(
  db,
  prices,
  executor,
  positions,
  notify,
  activity,
);
engine = new TradingEngine(
  db,
  prices,
  copyTrade,
  positions,
  notify,
  () => watched,
  activity,
  health,
);
const fomoscan = new FomoScanClient(
  config.FOMOSCAN_API_BASE,
  config.FOMOSCAN_API_KEY,
);
const traders = new TraderService(db, fomoscan, refreshWatchers, activity);
const sourcing = new SourcingService(db, prices, earlyBuyerSource);
const marketSignals = new MarketSignalService(db, prices, earlyBuyerSource, rpc);
const autoTrading = new AutoTradingService(db, prices, executor, notify, activity);
const sourcingScanOptions = {
  maxTokens: config.SOURCING_SCAN_MAX_TOKENS,
  minLiquidityUsd: config.SOURCING_MIN_LIQUIDITY_USD,
  minVolumeH1Usd: config.SOURCING_MIN_VOLUME_H1_USD,
  minTxnsH1: config.SOURCING_MIN_TXNS_H1,
  minAgeMinutes: config.SOURCING_MIN_AGE_MINUTES,
  maxAgeHours: config.SOURCING_MAX_AGE_HOURS,
  minPeakMultiple: config.SOURCING_MIN_PEAK_MULTIPLE,
};
telegram = new TelegramController(
  config,
  db,
  traders,
  positions,
  prices,
  rpc,
  retryExecutions,
);
const reconciler = new SubmissionReconciler(db, rpc, notify);

const api = await buildApi(
  config,
  db,
  traders,
  positions,
  prices,
  rpc,
  activity,
  health,
  retryExecutions,
  sourcing,
  marketSignals,
);
await api.listen({ host: "0.0.0.0", port: config.API_PORT });
await telegram.start();
health.markTelegramStarted();
await refreshWatchers();

const positionTimer = setInterval(() => {
  positions
    .evaluateOpenPositions()
    .catch((error) => console.error("position_monitor_failed", error));
}, 5_000);
positionTimer.unref();
const reconcileTimer = setInterval(() => {
  reconciler
    .runOnce()
    .catch((error) => console.error("reconcile_loop_failed", error));
}, 10_000);
reconcileTimer.unref();

async function runSourcingScan() {
  const runtimeEnabled = await db.getBooleanSystemSetting(
    "sourcing_auto_discovery_enabled",
    config.SOURCING_AUTO_DISCOVERY_ENABLED,
  );
  if (
    !config.SOURCING_AUTO_DISCOVERY_ENABLED ||
    !runtimeEnabled ||
    !config.HELIUS_API_KEY
  )
    return;
  const result = await sourcing.scanTrendingTokens(sourcingScanOptions);
  console.log("sourcing_scan_completed", {
    scanned: result.scanned,
    eligible: result.eligible,
    processed: result.processed.length,
    skippedExisting: result.skippedExisting,
    errors: result.errors.length,
  });
}

const sourcingInitialTimer = setTimeout(() => {
  runSourcingScan()
    .then(() => autoTrading.runOnce())
    .catch((error) => console.error("sourcing_scan_failed", error));
}, 15_000);
sourcingInitialTimer.unref();
const sourcingTimer = setInterval(() => {
  runSourcingScan()
    .then(() => autoTrading.runOnce())
    .catch((error) => console.error("sourcing_scan_failed", error));
}, config.SOURCING_SCAN_INTERVAL_MS);
sourcingTimer.unref();
const autoTradingTimer = setInterval(() => {
  autoTrading
    .runOnce()
    .catch((error) => console.error("auto_trading_loop_failed", error));
}, 60_000);
autoTradingTimer.unref();
const marketSignalInitialTimer = setTimeout(() => {
  marketSignals
    .scan({ maxTokens: 20, deepCheckTokens: config.HELIUS_API_KEY ? 10 : 0 })
    .catch((error) => console.error("market_signal_scan_failed", error));
}, 25_000);
marketSignalInitialTimer.unref();
const marketSignalTimer = setInterval(() => {
  marketSignals
    .scan({ maxTokens: 20, deepCheckTokens: config.HELIUS_API_KEY ? 10 : 0 })
    .catch((error) => console.error("market_signal_scan_failed", error));
}, 300_000);
marketSignalTimer.unref();

async function shutdown(signal: string) {
  console.log("shutdown", signal);
  clearInterval(positionTimer);
  clearInterval(reconcileTimer);
  clearInterval(sourcingTimer);
  clearInterval(autoTradingTimer);
  clearInterval(marketSignalTimer);
  clearTimeout(marketSignalInitialTimer);
  clearTimeout(sourcingInitialTimer);
  await watcher.stop();
  await api.close();
  await db.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
