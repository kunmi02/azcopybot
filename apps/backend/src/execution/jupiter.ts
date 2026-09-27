import { apiErrorMessage, stringifyErrorValue } from "../errors.js";

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

export interface JupiterOrder extends JupiterQuote {
  transaction: string | null;
  requestId: string;
  router?: string;
  mode?: string;
  errorCode?: number;
  errorMessage?: string;
}

export interface JupiterExecuteResult {
  status: "Success" | "Failed";
  signature?: string;
  code?: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
  [key: string]: unknown;
}

export class JupiterClient {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {}

  get usesSwapV2() {
    return /\/swap\/v2\/?$/.test(this.baseUrl);
  }

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
    if (!res.ok) throw new Error(apiErrorMessage("JUPITER_QUOTE", res.status, body));
    return body as JupiterQuote;
  }

  async order(inputMint: string, outputMint: string, amount: bigint, slippageBps: number, taker: string): Promise<JupiterOrder> {
    const qs = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), taker, slippageBps: String(slippageBps) });
    const res = await fetch(`${this.baseUrl}/order?${qs}`, { headers: this.headers() });
    const body: any = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
    if (!res.ok) throw new Error(apiErrorMessage("JUPITER_ORDER", res.status, body));
    if (!body?.transaction) {
      const detail = body?.errorMessage ?? body?.error ?? stringifyErrorValue(body);
      throw new Error(`JUPITER_ORDER_NO_TRANSACTION:${body?.router ?? "unknown"}:${body?.errorCode ?? "unknown"}:${detail}`);
    }
    return body as JupiterOrder;
  }

  async execute(signedTransaction: string, requestId: string): Promise<JupiterExecuteResult> {
    const res = await fetch(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ signedTransaction, requestId }),
    });
    const body: any = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
    if (!res.ok) throw new Error(apiErrorMessage("JUPITER_EXECUTE", res.status, body));
    if (body?.status !== "Success") {
      throw new Error(`JUPITER_EXECUTE_FAILED:${body?.signature ?? "no_signature"}:${body?.code ?? "unknown"}:${body?.error ?? stringifyErrorValue(body)}`);
    }
    return body as JupiterExecuteResult;
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
      throw new Error(apiErrorMessage("JUPITER_SWAP", res.status, body));
    }
    return String(body.swapTransaction);
  }
}
