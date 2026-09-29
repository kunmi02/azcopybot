export interface TokenMarket {
  priceUsd: number;
  liquidityUsd: number;
  symbol?: string;
  name?: string;
}

export interface DiscoveryToken {
  tokenAddress: string;
  symbol?: string;
  name?: string;
  priceUsd: number;
  liquidityUsd: number;
  volumeH1Usd: number;
  volumeH6Usd: number;
  volumeH24Usd: number;
  txnsH1: number;
  txnsH6: number;
  priceChangeM5Pct: number;
  priceChangeH1Pct: number;
  priceChangeH6Pct: number;
  priceChangeH24Pct: number;
  pairCreatedAt: Date | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  url?: string;
  sources: string[];
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

  async discoverSolanaTokens(): Promise<DiscoveryToken[]> {
    const [profiles, latestBoosts, topBoosts] = await Promise.all([
      fetchDexArray("https://api.dexscreener.com/token-profiles/latest/v1"),
      fetchDexArray("https://api.dexscreener.com/token-boosts/latest/v1"),
      fetchDexArray("https://api.dexscreener.com/token-boosts/top/v1"),
    ]);
    const sourceByToken = new Map<string, Set<string>>();
    for (const item of profiles) addSeed(sourceByToken, item, "latest_profile");
    for (const item of latestBoosts)
      addSeed(sourceByToken, item, "latest_boost");
    for (const item of topBoosts) addSeed(sourceByToken, item, "top_boost");

    const tokens = [...sourceByToken.keys()];
    const pairs: any[] = [];
    for (const chunk of chunked(tokens, 30)) {
      const body = await fetchDexArray(
        `https://api.dexscreener.com/tokens/v1/solana/${chunk.map(encodeURIComponent).join(",")}`,
      );
      pairs.push(...body);
    }

    const best = new Map<string, DiscoveryToken>();
    for (const pair of pairs) {
      if (pair?.chainId !== "solana") continue;
      const tokenAddress = pair?.baseToken?.address;
      if (!tokenAddress || !sourceByToken.has(tokenAddress)) continue;
      const candidate = normalizeDiscoveryPair(
        pair,
        [...(sourceByToken.get(tokenAddress) ?? [])],
      );
      if (!candidate) continue;
      const current = best.get(tokenAddress);
      if (!current || candidate.liquidityUsd > current.liquidityUsd) {
        best.set(tokenAddress, candidate);
      }
    }
    return [...best.values()];
  }
}

async function fetchDexArray(url: string) {
  const res = await fetch(url);
  if (!res.ok) return [];
  const body: unknown = await res.json().catch(() => []);
  return Array.isArray(body) ? body : [];
}

function addSeed(
  sourceByToken: Map<string, Set<string>>,
  item: any,
  source: string,
) {
  if (item?.chainId !== "solana" || !item?.tokenAddress) return;
  const tokenAddress = String(item.tokenAddress);
  const sources = sourceByToken.get(tokenAddress) ?? new Set<string>();
  sources.add(source);
  sourceByToken.set(tokenAddress, sources);
}

function normalizeDiscoveryPair(
  pair: any,
  sources: string[],
): DiscoveryToken | null {
  const priceUsd = Number(pair.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const txnsH1 =
    Number(pair.txns?.h1?.buys ?? 0) + Number(pair.txns?.h1?.sells ?? 0);
  const txnsH6 =
    Number(pair.txns?.h6?.buys ?? 0) + Number(pair.txns?.h6?.sells ?? 0);
  return {
    tokenAddress: String(pair.baseToken.address),
    symbol: pair.baseToken?.symbol,
    name: pair.baseToken?.name,
    priceUsd,
    liquidityUsd: Number(pair.liquidity?.usd ?? 0),
    volumeH1Usd: Number(pair.volume?.h1 ?? 0),
    volumeH6Usd: Number(pair.volume?.h6 ?? 0),
    volumeH24Usd: Number(pair.volume?.h24 ?? 0),
    txnsH1,
    txnsH6,
    priceChangeM5Pct: Number(pair.priceChange?.m5 ?? 0),
    priceChangeH1Pct: Number(pair.priceChange?.h1 ?? 0),
    priceChangeH6Pct: Number(pair.priceChange?.h6 ?? 0),
    priceChangeH24Pct: Number(pair.priceChange?.h24 ?? 0),
    pairCreatedAt: Number.isFinite(Number(pair.pairCreatedAt))
      ? new Date(Number(pair.pairCreatedAt))
      : null,
    marketCapUsd: Number.isFinite(Number(pair.marketCap))
      ? Number(pair.marketCap)
      : null,
    fdvUsd: Number.isFinite(Number(pair.fdv)) ? Number(pair.fdv) : null,
    url: pair.url,
    sources,
  };
}

function chunked<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
