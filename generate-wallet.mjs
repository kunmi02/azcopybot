import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const wallet = Keypair.generate();

console.log("PUBLIC ADDRESS:");
console.log(wallet.publicKey.toBase58());

console.log("\nPRIVATE KEY:");
console.log(bs58.encode(wallet.secretKey));