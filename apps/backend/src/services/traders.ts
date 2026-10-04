import type { Database } from "../db.js";
import type { FomoScanClient } from "../sources/fomoscan.js";
import { PublicKey } from "@solana/web3.js";
import type { ActivityService } from "./activity.js";

export class TraderService {
  constructor(
    private readonly db: Database,
    private readonly fomoscan: FomoScanClient,
    private readonly refreshWatchers: () => Promise<void>,
    private readonly activity?: ActivityService,
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
    const removed = await this.db.unfollowCopyConfig(userId, configId);
    if (!removed) throw new Error("CONFIG_NOT_FOUND");
    await this.refreshWatchers();
    const label = removed.handle ? `@${removed.handle}` : removed.display_name;
    await this.activity?.emit({
      userId,
      traderId: removed.trader_id,
      type: "trader_unfollowed",
      severity: "warning",
      message: `Unfollowed ${label}. Future signals are stopped; existing positions remain manageable.`,
      metadata: { configId },
    });
    return { ok: true, removedConfigId: removed.id, trader: label };
  }

  async updateConfig(userId: string, configId: string, patch: Parameters<Database["updateCopyConfig"]>[2]) {
    const updated = await this.db.updateCopyConfig(userId, configId, patch);
    if ("enabled" in patch) await this.refreshWatchers();
    return updated;
  }

  async followWallet(userId: string, input: { label: string; chain: string; address: string }) {
    if (input.chain !== "solana") throw new Error("CHAIN_NOT_ENABLED_IN_V1");
    try { new PublicKey(input.address); } catch { throw new Error("INVALID_SOLANA_ADDRESS"); }
    const trader = await this.db.upsertManualTrader(input);
    if (!trader) throw new Error("TRADER_UPSERT_FAILED");
    const config = await this.db.followTrader(userId, trader.id, input.label);
    await this.refreshWatchers();
    return { trader, config };
  }
}
