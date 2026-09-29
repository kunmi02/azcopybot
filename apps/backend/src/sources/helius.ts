export type EarlyBuyer = {
  wallet: string;
  signature: string;
  buyTime: Date;
  tokenAmount: number | null;
  buyAmountUsd: number | null;
  buyerRank: number;
  metadata: Record<string, unknown>;
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

export class NoopEarlyBuyerSource implements EarlyBuyerSource {
  readonly provider = "none";
  async findEarlyBuyers(): Promise<EarlyBuyer[]> {
    throw new Error("EARLY_BUYER_PROVIDER_NOT_CONFIGURED");
  }
}

export class HeliusEarlyBuyerSource implements EarlyBuyerSource {
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
}
