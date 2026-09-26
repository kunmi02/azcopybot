/**
 * V1 intentionally executes/monitors Solana only.
 * This interface is the extension seam for Base/BNB/Ethereum. Keep platform
 * discovery separate from chain ingestion so adding EVM does not touch FOMO.
 */
export interface EvmWatcher {
  reconfigure(addresses: string[]): Promise<void>;
  stop(): Promise<void>;
}
