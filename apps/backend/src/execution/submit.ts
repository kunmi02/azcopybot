import { VersionedTransaction } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import { SolanaRpc } from "../chains/solana/rpc.js";

export class SubmissionUnknownError extends Error {
  constructor(readonly signature: string) {
    super(`SUBMISSION_CONFIRMATION_UNKNOWN:${signature}`);
  }
}

/**
 * THE ONLY REAL SUBMISSION FUNCTION IN THE CODEBASE.
 * No other module may call the Solana `sendTransaction` RPC method.
 */
export async function submitSignedTransaction(
  rpc: SolanaRpc,
  base64Transaction: string,
  signer: Keypair,
): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Transaction, "base64"));
  const latest: any = await rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
  tx.message.recentBlockhash = latest.value.blockhash;
  tx.sign([signer]);
  const signed = Buffer.from(tx.serialize()).toString("base64");

  const signature = await rpc.call<string>("sendTransaction", [signed, {
    encoding: "base64",
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  }]);

  // Never blindly resubmit on a timeout. A timeout does not prove the transaction failed.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status: any = await rpc.call("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const value = status?.value?.[0];
    if (value?.err) throw new Error(`TRANSACTION_FAILED:${signature}:${JSON.stringify(value.err)}`);
    if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") return signature;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new SubmissionUnknownError(signature);
}
