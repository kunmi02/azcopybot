export type EarlyBuyer = {
  wallet: string;
  signature: string;
  buyTime: Date;
  tokenAmount: number | null;
  buyAmountUsd: number | null;
  buyerRank: number;
  metadata: Record<string, unknown>;
};

export type WalletSwap = {
  signature: string;
  timestamp: Date;
  side: "buy" | "sell";
  token: string;
  tokenAmount: number | null;
  quoteAmount: number | null;
  feePayer: string | null;
};

export type WalletTransaction = {
  signature: string;
  timestamp: Date;
  type: string;
  source: string | null;
  feePayer: string | null;
  description: string | null;
  nativeTransfers: Array<{
    fromUserAccount: string | null;
    toUserAccount: string | null;
    amountSol: number | null;
  }>;
  tokenTransfers: Array<{
    mint: string | null;
    fromUserAccount: string | null;
    toUserAccount: string | null;
    tokenAmount: number | null;
    tokenStandard: string | null;
  }>;
};

export interface EarlyBuyerSource {
  provider: string;
  findEarlyBuyers(input: {
    mint: string;
    limit: number;
    minTradeUsd: number;
    quoteMints: string[];
  }): Promise<EarlyBuyer[]>;
}

export interface WalletSwapActivitySource {
  provider: string;
  findWalletSwaps(input: {
    wallet: string;
    limit: number;
    quoteMints: string[];
  }): Promise<WalletSwap[]>;
}

export interface WalletTransactionSource {
  provider: string;
  findWalletTransactions(input: {
    wallet: string;
    limit: number;
    before?: string | null;
  }): Promise<WalletTransaction[]>;
}

export class NoopEarlyBuyerSource
  implements EarlyBuyerSource, WalletSwapActivitySource, WalletTransactionSource
{
  readonly provider = "none";
  async findEarlyBuyers(): Promise<EarlyBuyer[]> {
    throw new Error("EARLY_BUYER_PROVIDER_NOT_CONFIGURED");
  }

  async findWalletSwaps(): Promise<WalletSwap[]> {
    throw new Error("WALLET_ACTIVITY_PROVIDER_NOT_CONFIGURED");
  }

  async findWalletTransactions(): Promise<WalletTransaction[]> {
    throw new Error("WALLET_TRANSACTION_PROVIDER_NOT_CONFIGURED");
  }
}

export class HeliusEarlyBuyerSource
  implements EarlyBuyerSource, WalletSwapActivitySource, WalletTransactionSource
{
  readonly provider = "helius";
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async findEarlyBuyers(input: {
    mint: string;
    limit: number;
    minTradeUsd: number;
    quoteMints: string[];
  }) {
    const url = new URL(
      `${this.baseUrl.replace(/\/$/, "")}/addresses/${input.mint}/transactions`,
    );
    url.searchParams.set("api-key", this.apiKey);
    url.searchParams.set(
      "limit",
      String(Math.min(100, Math.max(10, input.limit * 3))),
    );
    url.searchParams.set("type", "SWAP");
    url.searchParams.set("token-accounts", "balanceChanged");
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(
        `HELIUS_EARLY_BUYERS_HTTP_${res.status}:${await res.text().catch(() => "")}`.slice(
          0,
          500,
        ),
      );
    const txs: any[] = await res.json();
    if (!Array.isArray(txs)) return [];

    const quoteSet = new Set(input.quoteMints);
    const buyers: EarlyBuyer[] = [];
    const seen = new Set<string>();
    const sorted = txs
      .filter((tx) => tx?.signature && tx?.timestamp)
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

    for (const tx of sorted) {
      const tokenTransfers: any[] = Array.isArray(tx.tokenTransfers)
        ? tx.tokenTransfers
        : [];
      const nativeTransfers: any[] = Array.isArray(tx.nativeTransfers)
        ? tx.nativeTransfers
        : [];
      const tokenReceived = tokenTransfers.filter(
        (t) =>
          t.mint === input.mint && t.toUserAccount && Number(t.tokenAmount) > 0,
      );
      if (!tokenReceived.length) continue;
      for (const receive of tokenReceived) {
        const wallet = String(receive.toUserAccount);
        if (seen.has(wallet)) continue;
        const quoteOut = tokenTransfers
          .filter(
            (t) =>
              quoteSet.has(String(t.mint)) &&
              t.fromUserAccount === wallet &&
              Number(t.tokenAmount) > 0,
          )
          .reduce((sum, t) => sum + Number(t.tokenAmount), 0);
        const solOut = nativeTransfers
          .filter((t) => t.fromUserAccount === wallet && Number(t.amount) > 0)
          .reduce((sum, t) => sum + Number(t.amount) / 1e9, 0);
        const estimatedUsd = quoteOut > 0 ? quoteOut : solOut > 0 ? null : null;
        if (estimatedUsd != null && estimatedUsd < input.minTradeUsd) continue;
        seen.add(wallet);
        buyers.push({
          wallet,
          signature: String(tx.signature),
          buyTime: new Date(Number(tx.timestamp) * 1000),
          tokenAmount: Number.isFinite(Number(receive.tokenAmount))
            ? Number(receive.tokenAmount)
            : null,
          buyAmountUsd: estimatedUsd,
          buyerRank: buyers.length + 1,
          metadata: {
            source: "helius_enhanced_transactions",
            feePayer: tx.feePayer ?? null,
            type: tx.type ?? null,
            quoteOut,
            solOut,
          },
        });
        if (buyers.length >= input.limit) return buyers;
      }
    }
    return buyers;
  }

  async findWalletSwaps(input: {
    wallet: string;
    limit: number;
    quoteMints: string[];
  }) {
    const url = new URL(
      `${this.baseUrl.replace(/\/$/, "")}/addresses/${input.wallet}/transactions`,
    );
    url.searchParams.set("api-key", this.apiKey);
    url.searchParams.set("limit", String(Math.min(100, Math.max(10, input.limit))));
    url.searchParams.set("type", "SWAP");
    url.searchParams.set("token-accounts", "balanceChanged");
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(
        `HELIUS_WALLET_SWAPS_HTTP_${res.status}:${await res.text().catch(() => "")}`.slice(
          0,
          500,
        ),
      );
    const txs: any[] = await res.json();
    if (!Array.isArray(txs)) return [];

    const quoteSet = new Set(input.quoteMints);
    const swaps: WalletSwap[] = [];
    for (const tx of txs) {
      if (!tx?.signature || !tx?.timestamp) continue;
      const tokenTransfers: any[] = Array.isArray(tx.tokenTransfers)
        ? tx.tokenTransfers
        : [];
      const nativeTransfers: any[] = Array.isArray(tx.nativeTransfers)
        ? tx.nativeTransfers
        : [];
      const quoteOut = tokenTransfers
        .filter(
          (t) =>
            quoteSet.has(String(t.mint)) &&
            t.fromUserAccount === input.wallet &&
            Number(t.tokenAmount) > 0,
        )
        .reduce((sum, t) => sum + Number(t.tokenAmount), 0);
      const quoteIn = tokenTransfers
        .filter(
          (t) =>
            quoteSet.has(String(t.mint)) &&
            t.toUserAccount === input.wallet &&
            Number(t.tokenAmount) > 0,
        )
        .reduce((sum, t) => sum + Number(t.tokenAmount), 0);
      const solOut = nativeTransfers
        .filter((t) => t.fromUserAccount === input.wallet && Number(t.amount) > 0)
        .reduce((sum, t) => sum + Number(t.amount) / 1e9, 0);
      const solIn = nativeTransfers
        .filter((t) => t.toUserAccount === input.wallet && Number(t.amount) > 0)
        .reduce((sum, t) => sum + Number(t.amount) / 1e9, 0);

      for (const transfer of tokenTransfers) {
        const mint = String(transfer.mint ?? "");
        if (!mint || quoteSet.has(mint)) continue;
        const amount = Number(transfer.tokenAmount);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        if (transfer.toUserAccount === input.wallet && (quoteOut > 0 || solOut > 0)) {
          swaps.push({
            signature: String(tx.signature),
            timestamp: new Date(Number(tx.timestamp) * 1000),
            side: "buy",
            token: mint,
            tokenAmount: amount,
            quoteAmount: quoteOut > 0 ? quoteOut : solOut > 0 ? null : null,
            feePayer: tx.feePayer ?? null,
          });
        } else if (
          transfer.fromUserAccount === input.wallet &&
          (quoteIn > 0 || solIn > 0)
        ) {
          swaps.push({
            signature: String(tx.signature),
            timestamp: new Date(Number(tx.timestamp) * 1000),
            side: "sell",
            token: mint,
            tokenAmount: amount,
            quoteAmount: quoteIn > 0 ? quoteIn : solIn > 0 ? null : null,
            feePayer: tx.feePayer ?? null,
          });
        }
      }
    }
    return dedupeSwaps(swaps)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, input.limit);
  }

  async findWalletTransactions(input: {
    wallet: string;
    limit: number;
    before?: string | null;
  }) {
    const url = new URL(
      `${this.baseUrl.replace(/\/$/, "")}/addresses/${input.wallet}/transactions`,
    );
    url.searchParams.set("api-key", this.apiKey);
    url.searchParams.set("limit", String(Math.min(100, Math.max(10, input.limit))));
    if (input.before) url.searchParams.set("before", input.before);
    url.searchParams.set("token-accounts", "balanceChanged");
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(
        `HELIUS_WALLET_TRANSACTIONS_HTTP_${res.status}:${await res.text().catch(() => "")}`.slice(
          0,
          500,
        ),
      );
    const txs: any[] = await res.json();
    if (!Array.isArray(txs)) return [];

    return txs
      .filter((tx) => tx?.signature && tx?.timestamp)
      .map((tx) => ({
        signature: String(tx.signature),
        timestamp: new Date(Number(tx.timestamp) * 1000),
        type: String(tx.type ?? "UNKNOWN"),
        source: tx.source == null ? null : String(tx.source),
        feePayer: tx.feePayer == null ? null : String(tx.feePayer),
        description: tx.description == null ? null : String(tx.description),
        nativeTransfers: normalizeNativeTransfers(tx.nativeTransfers).slice(0, 20),
        tokenTransfers: normalizeTokenTransfers(tx.tokenTransfers).slice(0, 40),
      }))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, input.limit);
  }

}

function normalizeNativeTransfers(value: unknown): WalletTransaction["nativeTransfers"] {
  if (!Array.isArray(value)) return [];
  return value.map((transfer: any) => ({
    fromUserAccount:
      transfer?.fromUserAccount == null ? null : String(transfer.fromUserAccount),
    toUserAccount:
      transfer?.toUserAccount == null ? null : String(transfer.toUserAccount),
    amountSol: Number.isFinite(Number(transfer?.amount))
      ? Number(transfer.amount) / 1e9
      : null,
  }));
}

function normalizeTokenTransfers(value: unknown): WalletTransaction["tokenTransfers"] {
  if (!Array.isArray(value)) return [];
  return value.map((transfer: any) => ({
    mint: transfer?.mint == null ? null : String(transfer.mint),
    fromUserAccount:
      transfer?.fromUserAccount == null ? null : String(transfer.fromUserAccount),
    toUserAccount:
      transfer?.toUserAccount == null ? null : String(transfer.toUserAccount),
    tokenAmount: Number.isFinite(Number(transfer?.tokenAmount))
      ? Number(transfer.tokenAmount)
      : null,
    tokenStandard:
      transfer?.tokenStandard == null ? null : String(transfer.tokenStandard),
  }));
}

function dedupeSwaps(swaps: WalletSwap[]) {
  const seen = new Set<string>();
  const out: WalletSwap[] = [];
  for (const swap of swaps) {
    const key = `${swap.signature}:${swap.side}:${swap.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(swap);
  }
  return out;
}
