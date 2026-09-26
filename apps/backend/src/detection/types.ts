import type { Chain } from "../types.js";

export interface TokenAccountBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  amount: bigint;
}

export interface TransactionSnapshot {
  chain: Chain;
  txHash: string;
  accountKeys: string[];
  signerAddresses: string[];
  preNativeBalances: bigint[];
  postNativeBalances: bigint[];
  preTokenBalances: TokenAccountBalance[];
  postTokenBalances: TokenAccountBalance[];
  feeLamports?: bigint;
  feePayer?: string;
}

export interface DetectionCandidate {
  classification: "buy" | "full_exit";
  wallet: string;
  token: string;
  quoteAsset?: string;
  quoteAmountRaw?: bigint;
  tokenAmountRaw?: bigint;
  preTokenAmountRaw?: bigint;
  requiresLiquidityCheck: boolean;
}
