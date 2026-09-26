import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

export function loadSolanaSigner(signerRef: string): Keypair {
  if (!/^[A-Z0-9_]+$/.test(signerRef)) throw new Error("INVALID_SIGNER_REF");
  const envName = `TRADING_WALLET_${signerRef}_PRIVATE_KEY`;
  const encoded = process.env[envName];
  if (!encoded) throw new Error(`MISSING_SIGNING_KEY:${envName}`);
  const secret = bs58.decode(encoded);
  if (secret.length !== 64) throw new Error(`INVALID_SIGNING_KEY_LENGTH:${envName}`);
  return Keypair.fromSecretKey(secret);
}
