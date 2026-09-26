export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  routePlan?: unknown[];
  [key: string]: unknown;
}

export class JupiterClient {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {}

  private headers(json = false) {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<JupiterQuote> {
    const qs = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), instructionVersion: "V2" });
    const res = await fetch(`${this.baseUrl}/quote?${qs}`, { headers: this.headers() });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? body?.message ?? `JUPITER_QUOTE_${res.status}`);
    return body as JupiterQuote;
  }

  async buildSwap(quoteResponse: JupiterQuote, userPublicKey: string) {
    const res = await fetch(`${this.baseUrl}/swap`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: { priorityLevel: "veryHigh", maxLamports: 1_000_000 },
        },
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.swapTransaction) {
      throw new Error(body?.error ?? body?.message ?? `JUPITER_SWAP_${res.status}`);
    }
    return String(body.swapTransaction);
  }
}
