export interface TokenMarket {
  priceUsd: number;
  liquidityUsd: number;
  symbol?: string;
  name?: string;
}

export class DexScreenerPriceService {
  async getTokenMarket(address: string): Promise<TokenMarket | null> {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    const body: any = await res.json();
    const pairs: any[] = Array.isArray(body.pairs) ? body.pairs : [];
    const valid = pairs
      .map((p) => ({
        priceUsd: Number(p.priceUsd),
        liquidityUsd: Number(p.liquidity?.usd ?? 0),
        symbol: p.baseToken?.symbol as string | undefined,
        name: p.baseToken?.name as string | undefined,
      }))
      .filter((p) => Number.isFinite(p.priceUsd) && p.priceUsd > 0)
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    return valid[0] ?? null;
  }
}
