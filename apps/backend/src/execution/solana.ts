import { DexScreenerPriceService } from "../services/pricing.js";
import { SolanaRpc } from "../chains/solana/rpc.js";
import { JupiterClient } from "./jupiter.js";
import { submitSignedTransaction } from "./submit.js";
import { loadSolanaSigner } from "../wallet.js";

export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MIN_SOL_LAMPORTS = 50_000_000n; // 0.05 SOL

export class SolanaExecutor {
  constructor(
    private readonly rpc: SolanaRpc,
    private readonly jupiter: JupiterClient,
    private readonly prices: DexScreenerPriceService,
  ) {}

  async buy(input: {
    signerRef: string;
    expectedPublicAddress: string;
    token: string;
    amountUsd: number;
    slippageBps: number;
  }) {
    const signer = loadSolanaSigner(input.signerRef);
    if (signer.publicKey.toBase58() !== input.expectedPublicAddress) throw new Error("SIGNER_PUBLIC_KEY_MISMATCH");
    const solBalance = await this.rpc.solBalance(input.expectedPublicAddress);
    if (solBalance < MIN_SOL_LAMPORTS) throw new Error("LOW_SOL_FOR_GAS");

    const inputAmount = BigInt(Math.round(input.amountUsd * 1_000_000));
    const usdcBalance = await this.rpc.tokenBalanceRaw(input.expectedPublicAddress, SOLANA_USDC);
    if (usdcBalance < inputAmount) throw new Error("INSUFFICIENT_USDC");
    return this.withMissingTokenProgramRetry(async () => {
      const [quote, transferFeeBps] = await Promise.all([
        this.jupiter.quote(SOLANA_USDC, input.token, inputAmount, input.slippageBps),
        this.rpc.transferFeeBps(input.token),
      ]);

      if (transferFeeBps !== 0) {
        // The supplied spec requires a tested fallback router here. We refuse rather than silently use a dangerous route.
        throw new Error(`TOKEN_2022_TRANSFER_FEE_REQUIRES_FALLBACK:${transferFeeBps}`);
      }

      await this.assertQuoteValue(input.token, BigInt(quote.outAmount), input.amountUsd);
      const swap = await this.jupiter.buildSwap(quote, input.expectedPublicAddress);
      const txHash = await submitSignedTransaction(this.rpc, swap, signer);
      const decimals = await this.rpc.tokenDecimals(input.token);
      const tokenQty = Number(BigInt(quote.outAmount)) / 10 ** decimals;
      const executionPrice = input.amountUsd / tokenQty;
      return { txHash, tokenQty, actualUsd: input.amountUsd, executionPrice };
    });
  }

  async sell(input: {
    signerRef: string;
    expectedPublicAddress: string;
    token: string;
    tokenQty: number;
    slippageBps: number;
    expectedUsd: number;
  }) {
    const signer = loadSolanaSigner(input.signerRef);
    if (signer.publicKey.toBase58() !== input.expectedPublicAddress) throw new Error("SIGNER_PUBLIC_KEY_MISMATCH");
    const solBalance = await this.rpc.solBalance(input.expectedPublicAddress);
    if (solBalance < MIN_SOL_LAMPORTS) throw new Error("LOW_SOL_FOR_GAS");
    const decimals = await this.rpc.tokenDecimals(input.token);
    const rawQty = BigInt(Math.floor(input.tokenQty * 10 ** decimals));
    const onChainBalance = await this.rpc.tokenBalanceRaw(input.expectedPublicAddress, input.token);
    if (onChainBalance < rawQty) throw new Error("INSUFFICIENT_TOKEN_BALANCE");

    return this.withMissingTokenProgramRetry(async () => {
      const [quote, transferFeeBps] = await Promise.all([
        this.jupiter.quote(input.token, SOLANA_USDC, rawQty, input.slippageBps),
        this.rpc.transferFeeBps(input.token),
      ]);
      if (transferFeeBps !== 0) throw new Error(`TOKEN_2022_TRANSFER_FEE_REQUIRES_FALLBACK:${transferFeeBps}`);

      const quotedUsd = Number(BigInt(quote.outAmount)) / 1_000_000;
      if (input.expectedUsd > 1 && quotedUsd < input.expectedUsd * 0.5) throw new Error("VALUE_SANITY_CHECK_FAILED");
      const swap = await this.jupiter.buildSwap(quote, input.expectedPublicAddress);
      const txHash = await submitSignedTransaction(this.rpc, swap, signer);
      return { txHash, actualUsd: quotedUsd, executionPrice: quotedUsd / input.tokenQty };
    });
  }

  private async assertQuoteValue(token: string, rawOut: bigint, expectedUsd: number) {
    const [market, decimals] = await Promise.all([this.prices.getTokenMarket(token), this.rpc.tokenDecimals(token)]);
    if (!market) throw new Error("PRICE_UNAVAILABLE_FOR_SANITY_CHECK");
    const qty = Number(rawOut) / 10 ** decimals;
    const quotedUsd = qty * market.priceUsd;
    if (expectedUsd > 1 && quotedUsd < expectedUsd * 0.5) throw new Error("VALUE_SANITY_CHECK_FAILED");
  }

  private async withMissingTokenProgramRetry<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await fn(); }
      catch (error) {
        last = error;
        if (!String(error).includes("Missing token program")) throw error;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw last;
  }
}
