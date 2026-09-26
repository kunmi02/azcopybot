import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { FomoScanClient } from "./sources/fomoscan.js";
import { DexScreenerPriceService } from "./services/pricing.js";
import { SolanaRpc } from "./chains/solana/rpc.js";
import { JupiterClient } from "./execution/jupiter.js";
import { SolanaExecutor } from "./execution/solana.js";
import { SolanaGrpcWatcher } from "./chains/solana/grpc.js";
import { CopyTradeService } from "./services/copytrade.js";
import { PositionService } from "./services/positions.js";
import { TradingEngine } from "./services/engine.js";
import { TraderService } from "./services/traders.js";
import { TelegramController } from "./telegram.js";
import { buildApi } from "./api.js";
import { SubmissionReconciler } from "./services/reconcile.js";

const config = loadConfig();
const db = new Database(config.DATABASE_URL);
await db.migrate();

// Ensure allowlisted Telegram users exist only after they start the bot; bootstrap only copy-wallet bindings.
for (const item of config.bootstrapUsers) {
  const user = await db.getUserByTelegramId(item.telegramUserId);
  if (user) await db.upsertCopyWallet(user.id, "solana", item.solanaAddress, item.signerRef);
}

const prices = new DexScreenerPriceService();
const rpc = new SolanaRpc(config.SOLANA_RPC_URL);
const jupiter = new JupiterClient(config.JUPITER_API_BASE, config.JUPITER_API_KEY);
const executor = new SolanaExecutor(rpc, jupiter, prices);

let watched = new Set<string>();
let telegram!: TelegramController;
let engine!: TradingEngine;
const watcher = new SolanaGrpcWatcher(config.TRITON_GRPC_ENDPOINT, config.TRITON_GRPC_XTOKEN, async (snapshot) => {
  await engine.processSnapshot(snapshot);
});

async function refreshWatchers() {
  watched = new Set(await db.listSolanaWatchedAddresses());
  await watcher.reconfigure([...watched]);
  console.log("watcher_reconfigured", { wallets: watched.size });
}

// Temporary notify closure is safe because telegram is assigned before any stream is started.
const notify = async (chatId: string, text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>) => {
  await telegram.notify(chatId, text, buttons);
};

const positions = new PositionService(db, prices, executor, notify);
const copyTrade = new CopyTradeService(db, prices, executor, notify);
engine = new TradingEngine(db, prices, copyTrade, positions, notify, () => watched);
const fomoscan = new FomoScanClient(config.FOMOSCAN_API_BASE, config.FOMOSCAN_API_KEY);
const traders = new TraderService(db, fomoscan, refreshWatchers);
telegram = new TelegramController(config, db, traders, positions, rpc);
const reconciler = new SubmissionReconciler(db, rpc, notify);

const api = await buildApi(config, db, traders, positions, prices, rpc);
await api.listen({ host: "0.0.0.0", port: config.API_PORT });
await telegram.start();
await refreshWatchers();

const positionTimer = setInterval(() => {
  positions.evaluateOpenPositions().catch((error) => console.error("position_monitor_failed", error));
}, 5_000);
positionTimer.unref();
const reconcileTimer = setInterval(() => {
  reconciler.runOnce().catch((error) => console.error("reconcile_loop_failed", error));
}, 10_000);
reconcileTimer.unref();

async function shutdown(signal: string) {
  console.log("shutdown", signal);
  clearInterval(positionTimer);
  clearInterval(reconcileTimer);
  await watcher.stop();
  await api.close();
  await db.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
