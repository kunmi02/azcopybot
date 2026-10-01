import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { SolanaExecutor, SOLANA_USDC } from "./solana.js";

test("Token-2022 transfer-fee buy is refused when fallback is disabled", async () => {
  const signer = Keypair.generate();
  process.env.TRADING_WALLET_TEST_SOL_PRIVATE_KEY = bs58.encode(
    signer.secretKey,
  );
  const rpc = fakeRpc({ transferFeeBps: 300 });
  const executor = new SolanaExecutor(rpc as any, {} as any, {} as any);

  await assert.rejects(
    () =>
      executor.buy({
        signerRef: "TEST_SOL",
        expectedPublicAddress: signer.publicKey.toBase58(),
        token: "Token2022Mint",
        amountUsd: 1,
        slippageBps: 300,
      }),
    /TOKEN_2022_FALLBACK_DISABLED:300/,
  );
});

test("Token-2022 transfer-fee sell is refused when fallback is enabled but OKX is missing", async () => {
  const signer = Keypair.generate();
  process.env.TRADING_WALLET_TEST_SOL_PRIVATE_KEY = bs58.encode(
    signer.secretKey,
  );
  const rpc = fakeRpc({ transferFeeBps: 300 });
  const executor = new SolanaExecutor(
    rpc as any,
    {} as any,
    {} as any,
    undefined,
    true,
  );

  await assert.rejects(
    () =>
      executor.sell({
        signerRef: "TEST_SOL",
        expectedPublicAddress: signer.publicKey.toBase58(),
        token: "Token2022Mint",
        tokenQty: 1,
        slippageBps: 300,
        expectedUsd: 1,
      }),
    /TOKEN_2022_FALLBACK_NOT_CONFIGURED:300/,
  );
});

function fakeRpc(input: { transferFeeBps: number }) {
  return {
    solBalance: async () => 100_000_000n,
    tokenBalanceRaw: async (_owner: string, mint: string) =>
      mint === SOLANA_USDC ? 10_000_000n : 10_000_000_000n,
    transferFeeBps: async () => input.transferFeeBps,
    tokenDecimals: async () => 6,
  };
}
