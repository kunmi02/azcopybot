import { createHmac } from "node:crypto";
import bs58 from "bs58";
import { apiErrorMessage, stringifyErrorValue } from "../errors.js";

const SOLANA_CHAIN_ID = "501";

export interface OkxSwapResult {
  transactionBase64: string;
  outAmount: string;
  routerResult: Record<string, unknown>;
}

export class OkxRouter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly apiSecret?: string,
    private readonly apiPassphrase?: string,
    private readonly projectId?: string,
  ) {}

  isConfigured() {
    return Boolean(
      this.apiKey &&
        this.apiSecret &&
        this.apiPassphrase &&
        this.projectId,
    );
  }

  async swap(input: {
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: bigint;
    slippageBps: number;
    userWalletAddress: string;
  }): Promise<OkxSwapResult> {
    if (!this.isConfigured()) throw new Error("OKX_NOT_CONFIGURED");
    const requestPath = "/api/v5/dex/aggregator/swap";
    const queryString =
      "?" +
      new URLSearchParams({
        chainId: SOLANA_CHAIN_ID,
        amount: input.amount.toString(),
        fromTokenAddress: input.fromTokenAddress,
        toTokenAddress: input.toTokenAddress,
        slippage: slippagePercent(input.slippageBps),
        userWalletAddress: input.userWalletAddress,
      }).toString();
    const body = await this.get(requestPath, queryString);
    const item = Array.isArray(body?.data) ? body.data[0] : body;
    const tx = extractTransactionBase64(item);
    const outAmount = extractOutAmount(item);
    if (!tx) throw new Error(`OKX_SWAP_NO_TRANSACTION:${stringifyErrorValue(body)}`);
    if (!outAmount) throw new Error(`OKX_SWAP_NO_OUT_AMOUNT:${stringifyErrorValue(body)}`);
    return {
      transactionBase64: tx,
      outAmount,
      routerResult: item?.routerResult ?? item ?? {},
    };
  }

  private async get(requestPath: string, queryString: string) {
    const timestamp = new Date().toISOString();
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${requestPath}${queryString}`, {
      method: "GET",
      headers: this.headers(timestamp, "GET", requestPath, queryString),
    });
    const body: any = await res.json().catch(async () => ({
      error: await res.text().catch(() => ""),
    }));
    if (!res.ok) throw new Error(apiErrorMessage("OKX_SWAP", res.status, body));
    if (body?.code && body.code !== "0") {
      throw new Error(`OKX_SWAP_${body.code}:${body.msg ?? stringifyErrorValue(body)}`);
    }
    return body;
  }

  private headers(
    timestamp: string,
    method: "GET" | "POST",
    requestPath: string,
    queryString = "",
  ) {
    if (!this.apiKey || !this.apiSecret || !this.apiPassphrase || !this.projectId) {
      throw new Error("OKX_NOT_CONFIGURED");
    }
    const sign = createHmac("sha256", this.apiSecret)
      .update(timestamp + method + requestPath + queryString)
      .digest("base64");
    return {
      "content-type": "application/json",
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.apiPassphrase,
      "OK-ACCESS-PROJECT": this.projectId,
    };
  }
}

function slippagePercent(slippageBps: number) {
  return (Math.max(0, slippageBps) / 100).toString();
}

function extractOutAmount(item: any): string | null {
  const value =
    item?.routerResult?.toTokenAmount ??
    item?.toTokenAmount ??
    item?.outAmount ??
    item?.tx?.toTokenAmount;
  return value == null ? null : String(value);
}

function extractTransactionBase64(item: any): string | null {
  const base64 = item?.swapTransactionData;
  if (typeof base64 === "string" && base64.length) return base64;
  const base58 = item?.tx?.data ?? item?.data;
  if (typeof base58 === "string" && base58.length) {
    return Buffer.from(bs58.decode(base58)).toString("base64");
  }
  return null;
}
