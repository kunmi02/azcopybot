import { DexScreenerPriceService } from "../services/pricing.js";
import { SolanaRpc } from "../chains/solana/rpc.js";
import { JupiterClient } from "./jupiter.js";
import { OkxRouter } from "./okx.js";
import { submitSignedTransaction } from "./submit.js";
import { VersionedTransaction } from "@solana/web3.js";
import { loadSolanaSigner } from "../wallet.js";

export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MIN_SOL_LAMPORTS = 50_000_000n; // 0.05 SOL

export class SolanaExecutor {
  constructor(
    private readonly rpc: SolanaRpc,
    private readonly jupiter: JupiterClient,
    private readonly prices: DexScreenerPriceService,
    private readonly okx?: OkxRouter,
    private readonly token2022FallbackEnabled = false,
  ) {}

  async buy(input: {
    signerRef: string;
    expectedPublicAddress: string;
    token: string;
    amountUsd: number;
    slippageBps: number;
    onProgress?: (stage: string, message: string, metadata?: Record<string, unknown>) => Promise<void> | void;
  }) {
    const signer = loadSolanaSigner(input.signerRef);
    if (signer.publicKey.toBase58() !== input.expectedPublicAddress) throw new Error("SIGNER_PUBLIC_KEY_MISMATCH");
    const solBalance = await this.rpc.solBalance(input.expectedPublicAddress);
    if (solBalance < MIN_SOL_LAMPORTS) throw new Error("LOW_SOL_FOR_GAS");

    const inputAmount = BigInt(Math.round(input.amountUsd * 1_000_000));
    const usdcBalance = await this.rpc.tokenBalanceRaw(input.expectedPublicAddress, SOLANA_USDC);
    if (usdcBalance < inputAmount) throw new Error("INSUFFICIENT_USDC");
    return this.withMissingTokenProgramRetry(async () => {
      await input.onProgress?.("quote_requested", "Jupiter quote requested", { token: input.token, amountUsd: input.amountUsd });
      const transferFeeBps = await this.rpc.transferFeeBps(input.token);
      if (transferFeeBps !== 0) {
        return this.buyWithFallback(input, inputAmount, transferFeeBps, signer);
      }
      if (this.jupiter.usesSwapV2) {
        const order = await this.jupiter.order(SOLANA_USDC, input.token, inputAmount, input.slippageBps, input.expectedPublicAddress);
        await input.onProgress?.("quote_received", "Jupiter order received", { token: input.token, outAmount: order.outAmount, router: order.router, mode: order.mode, transferFeeBps });
        await this.assertQuoteValue(input.token, BigInt(order.outAmount), input.amountUsd);
        await input.onProgress?.("transaction_submitting", "Signing and executing buy transaction", { token: input.token, router: order.router });
        const result = await this.signAndExecuteOrder(order.transaction!, order.requestId, signer);
        const decimals = await this.rpc.tokenDecimals(input.token);
        const rawOut = BigInt(result.totalOutputAmount ?? result.outputAmountResult ?? order.outAmount);
        const tokenQty = Number(rawOut) / 10 ** decimals;
        const executionPrice = input.amountUsd / tokenQty;
        return { txHash: result.signature!, tokenQty, actualUsd: input.amountUsd, executionPrice };
      }

      const [quote] = await Promise.all([
        this.jupiter.quote(SOLANA_USDC, input.token, inputAmount, input.slippageBps),
      ]);
      await input.onProgress?.("quote_received", "Jupiter quote received", { token: input.token, outAmount: quote.outAmount, transferFeeBps });
      await this.assertQuoteValue(input.token, BigInt(quote.outAmount), input.amountUsd);
      const swap = await this.jupiter.buildSwap(quote, input.expectedPublicAddress);
      await input.onProgress?.("transaction_submitting", "Signing and submitting buy transaction", { token: input.token });
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
    bypassValueSanity?: boolean;
    onProgress?: (stage: string, message: string, metadata?: Record<string, unknown>) => Promise<void> | void;
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
      await input.onProgress?.("quote_requested", "Jupiter sell quote requested", { token: input.token, tokenQty: input.tokenQty, expectedUsd: input.expectedUsd });
      const transferFeeBps = await this.rpc.transferFeeBps(input.token);
      if (transferFeeBps !== 0) {
        return this.sellWithFallback(input, rawQty, transferFeeBps, signer);
      }
      if (this.jupiter.usesSwapV2) {
        const order = await this.jupiter.order(input.token, SOLANA_USDC, rawQty, input.slippageBps, input.expectedPublicAddress);
        await input.onProgress?.("quote_received", "Jupiter sell order received", { token: input.token, outAmount: order.outAmount, router: order.router, mode: order.mode, transferFeeBps });
        const quotedUsd = Number(BigInt(order.outAmount)) / 1_000_000;
        if (!input.bypassValueSanity && input.expectedUsd > 1 && quotedUsd < input.expectedUsd * 0.5) throw new Error("VALUE_SANITY_CHECK_FAILED");
        await input.onProgress?.("transaction_submitting", "Signing and executing sell transaction", { token: input.token, router: order.router });
        const result = await this.signAndExecuteOrder(order.transaction!, order.requestId, signer);
        const actualUsd = Number(BigInt(result.totalOutputAmount ?? result.outputAmountResult ?? order.outAmount)) / 1_000_000;
        return { txHash: result.signature!, actualUsd, executionPrice: actualUsd / input.tokenQty };
      }

      const [quote] = await Promise.all([
        this.jupiter.quote(input.token, SOLANA_USDC, rawQty, input.slippageBps),
      ]);
      await input.onProgress?.("quote_received", "Jupiter sell quote received", { token: input.token, outAmount: quote.outAmount, transferFeeBps });

      const quotedUsd = Number(BigInt(quote.outAmount)) / 1_000_000;
      if (!input.bypassValueSanity && input.expectedUsd > 1 && quotedUsd < input.expectedUsd * 0.5) throw new Error("VALUE_SANITY_CHECK_FAILED");
      const swap = await this.jupiter.buildSwap(quote, input.expectedPublicAddress);
      await input.onProgress?.("transaction_submitting", "Signing and submitting sell transaction", { token: input.token });
      const txHash = await submitSignedTransaction(this.rpc, swap, signer);
      return { txHash, actualUsd: quotedUsd, executionPrice: quotedUsd / input.tokenQty };
    });
  }

  private async buyWithFallback(
    input: {
      signerRef: string;
      expectedPublicAddress: string;
      token: string;
      amountUsd: number;
      slippageBps: number;
      onProgress?: (stage: string, message: string, metadata?: Record<string, unknown>) => Promise<void> | void;
    },
    inputAmount: bigint,
    transferFeeBps: number,
    signer: import("@solana/web3.js").Keypair,
  ) {
    this.assertFallbackReady(transferFeeBps);
    await input.onProgress?.("quote_requested", "OKX fallback buy route requested", {
      token: input.token,
      amountUsd: input.amountUsd,
      transferFeeBps,
    });
    const route = await this.okx!.swap({
      fromTokenAddress: SOLANA_USDC,
      toTokenAddress: input.token,
      amount: inputAmount,
      slippageBps: input.slippageBps,
      userWalletAddress: input.expectedPublicAddress,
    });
    await input.onProgress?.("quote_received", "OKX fallback buy route received", {
      token: input.token,
      outAmount: route.outAmount,
      transferFeeBps,
      router: "okx",
    });
    await this.assertQuoteValue(input.token, BigInt(route.outAmount), input.amountUsd);
    await input.onProgress?.("transaction_submitting", "Signing and submitting OKX fallback buy transaction", {
      token: input.token,
      router: "okx",
    });
    const txHash = await submitSignedTransaction(this.rpc, route.transactionBase64, signer);
    const decimals = await this.rpc.tokenDecimals(input.token);
    const tokenQty = Number(BigInt(route.outAmount)) / 10 ** decimals;
    const executionPrice = input.amountUsd / tokenQty;
    return { txHash, tokenQty, actualUsd: input.amountUsd, executionPrice };
  }

  private async sellWithFallback(
    input: {
      signerRef: string;
      expectedPublicAddress: string;
      token: string;
      tokenQty: number;
      slippageBps: number;
      expectedUsd: number;
      bypassValueSanity?: boolean;
      onProgress?: (stage: string, message: string, metadata?: Record<string, unknown>) => Promise<void> | void;
    },
    rawQty: bigint,
    transferFeeBps: number,
    signer: import("@solana/web3.js").Keypair,
  ) {
    this.assertFallbackReady(transferFeeBps);
    await input.onProgress?.("quote_requested", "OKX fallback sell route requested", {
      token: input.token,
      tokenQty: input.tokenQty,
      transferFeeBps,
    });
    const route = await this.okx!.swap({
      fromTokenAddress: input.token,
      toTokenAddress: SOLANA_USDC,
      amount: rawQty,
      slippageBps: input.slippageBps,
      userWalletAddress: input.expectedPublicAddress,
    });
    await input.onProgress?.("quote_received", "OKX fallback sell route received", {
      token: input.token,
      outAmount: route.outAmount,
      transferFeeBps,
      router: "okx",
    });
    const actualUsd = Number(BigInt(route.outAmount)) / 1_000_000;
    if (!input.bypassValueSanity && input.expectedUsd > 1 && actualUsd < input.expectedUsd * 0.5) throw new Error("VALUE_SANITY_CHECK_FAILED");
    await input.onProgress?.("transaction_submitting", "Signing and submitting OKX fallback sell transaction", {
      token: input.token,
      router: "okx",
    });
    const txHash = await submitSignedTransaction(this.rpc, route.transactionBase64, signer);
    return { txHash, actualUsd, executionPrice: actualUsd / input.tokenQty };
  }

  private assertFallbackReady(transferFeeBps: number) {
    if (!this.token2022FallbackEnabled) {
      throw new Error(`TOKEN_2022_FALLBACK_DISABLED:${transferFeeBps}`);
    }
    if (!this.okx?.isConfigured()) {
      throw new Error(`TOKEN_2022_FALLBACK_NOT_CONFIGURED:${transferFeeBps}`);
    }
  }

  private async signAndExecuteOrder(base64Transaction: string, requestId: string, signer: import("@solana/web3.js").Keypair) {
    const tx = VersionedTransaction.deserialize(Buffer.from(base64Transaction, "base64"));
    tx.sign([signer]);
    const signedTransaction = Buffer.from(tx.serialize()).toString("base64");
    return this.jupiter.execute(signedTransaction, requestId);
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
