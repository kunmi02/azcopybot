import type { Database } from "../db.js";
import type { FomoScanClient } from "../sources/fomoscan.js";
import { PublicKey } from "@solana/web3.js";

export class TraderService {
  constructor(
    private readonly db: Database,
    private readonly fomoscan: FomoScanClient,
    private readonly refreshWatchers: () => Promise<void>,
  ) {}

  async resolveFomo(handle: string) {
    const cached = await this.db.getFomoTraderByHandle(handle);
    if (cached) {
      return {
        identity: { id: cached.external_id, handle: cached.handle, name: cached.display_name, solanaAddress: cached.solana_address, evmAddress: cached.evm_address },
        trader: cached, cached: true,
      };
    }
    const identity = await this.fomoscan.resolveHandle(handle);
    const trader = await this.db.upsertFomoTrader(identity);
    if (!trader) throw new Error("TRADER_UPSERT_FAILED");
    return { identity, trader, cached: false };
  }

  async followFomo(userId: string, handle: string) {
    const resolved = await this.resolveFomo(handle);
    if (!resolved.identity.solanaAddress) throw new Error("FOMO_TRADER_HAS_NO_SOLANA_WALLET_IN_V1");
    const config = await this.db.followTrader(userId, resolved.trader.id);
    await this.refreshWatchers();
    return { ...resolved, config };
  }

  async unfollow(userId: string, configId: string) {
    const config = await this.db.getCopyConfig(configId);
    if (!config || config.userId !== userId) throw new Error("CONFIG_NOT_FOUND");
    await this.db.updateCopyConfig(userId, configId, { enabled: false, dryRun: true });
    await this.refreshWatchers();
    return { ok: true };
  }

  async followWallet(userId: string, input: { label: string; chain: string; address: string }) {
    if (input.chain !== "solana") throw new Error("CHAIN_NOT_ENABLED_IN_V1");
    try { new PublicKey(input.address); } catch { throw new Error("INVALID_SOLANA_ADDRESS"); }
    const trader = await this.db.upsertManualTrader(input);
    if (!trader) throw new Error("TRADER_UPSERT_FAILED");
    const config = await this.db.followTrader(userId, trader.id);
    await this.refreshWatchers();
    return { trader, config };
  }
}
