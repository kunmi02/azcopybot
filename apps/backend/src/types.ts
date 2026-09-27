export type Chain = "solana" | "ethereum" | "base" | "bnb";
export type ChainFamily = "solana" | "evm";
export type TradeClassification = "buy" | "partial_exit" | "full_exit" | "neither";
export type EntryKind = "new_entry" | "top_up";

export interface TradeEvent {
  chain: Chain;
  txHash: string;
  wallet: string;
  token: string;
  classification: Exclude<TradeClassification, "neither">;
  quoteAsset?: string;
  quoteAmountRaw?: bigint;
  tokenAmountRaw?: bigint;
  preTokenAmountRaw?: bigint;
  tokenDecimals?: number;
  detectedAt: Date;
  requiresLiquidityCheck?: boolean;
}

export interface FomoIdentity {
  id: string;
  handle: string;
  name?: string | null;
  solanaAddress?: string | null;
  evmAddress?: string | null;
}

export interface CopyConfig {
  id: string;
  userId: string;
  traderId: string;
  tradingWalletId: string | null;
  tradeAmountUsd: number;
  slippageBps: number;
  copyNewEntries: boolean;
  copyTopups: boolean;
  mirrorExits: boolean;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  maxHoldSeconds: number | null;
  dryRun: boolean;
  enabled: boolean;
}

export function dedupeKey(event: TradeEvent) {
  return `${event.chain}:${event.txHash}:${event.wallet}:${event.token}`;
}
