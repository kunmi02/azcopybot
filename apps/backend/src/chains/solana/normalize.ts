import bs58 from "bs58";
import type { TransactionSnapshot, TokenAccountBalance } from "../../detection/types.js";

function bytes(value: any): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value.type === "Buffer" && Array.isArray(value.data)) return Uint8Array.from(value.data);
  if (value.data && Array.isArray(value.data)) return Uint8Array.from(value.data);
  return null;
}

function pubkey(value: any): string | null {
  if (typeof value === "string") return value;
  if (value?.pubkey) return pubkey(value.pubkey);
  const b = bytes(value);
  return b ? bs58.encode(b) : null;
}

function signature(value: any): string | null {
  if (typeof value === "string") return value;
  const b = bytes(value);
  return b ? bs58.encode(b) : null;
}

function tokenBalance(x: any): TokenAccountBalance | null {
  const mint = typeof x?.mint === "string" ? x.mint : pubkey(x?.mint);
  if (!mint) return null;
  const amount = x?.uiTokenAmount?.amount ?? x?.amount ?? "0";
  return {
    accountIndex: Number(x.accountIndex ?? x.account_index ?? -1),
    mint,
    owner: typeof x.owner === "string" ? x.owner : pubkey(x.owner) ?? undefined,
    amount: BigInt(String(amount)),
  };
}

export function normalizeYellowstoneTransaction(update: any): TransactionSnapshot | null {
  const wrapper = update?.transaction;
  const txInfo = wrapper?.transaction ?? wrapper;
  const versioned = txInfo?.transaction ?? txInfo;
  const message = versioned?.message ?? versioned?.transaction?.message;
  const meta = txInfo?.meta ?? wrapper?.meta;
  if (!message || !meta) return null;

  const staticKeys: string[] = (message.accountKeys ?? message.account_keys ?? [])
    .map(pubkey).filter(Boolean) as string[];
  const loadedWritable: string[] = (meta.loadedWritableAddresses ?? meta.loaded_writable_addresses ?? [])
    .map(pubkey).filter(Boolean) as string[];
  const loadedReadonly: string[] = (meta.loadedReadonlyAddresses ?? meta.loaded_readonly_addresses ?? [])
    .map(pubkey).filter(Boolean) as string[];
  const accountKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];

  const required = Number(message.header?.numRequiredSignatures ?? message.header?.num_required_signatures ?? 0);
  const signerAddresses = accountKeys.slice(0, required);
  const signatures = versioned?.signatures ?? [];
  const txHash = signature(wrapper?.signature) ?? signature(txInfo?.signature) ?? signature(signatures?.[0]);
  if (!txHash) return null;

  const preTokenBalances = (meta.preTokenBalances ?? meta.pre_token_balances ?? []).map(tokenBalance).filter(Boolean) as TokenAccountBalance[];
  const postTokenBalances = (meta.postTokenBalances ?? meta.post_token_balances ?? []).map(tokenBalance).filter(Boolean) as TokenAccountBalance[];
  const preNativeBalances = (meta.preBalances ?? meta.pre_balances ?? []).map((x: any) => BigInt(String(x)));
  const postNativeBalances = (meta.postBalances ?? meta.post_balances ?? []).map((x: any) => BigInt(String(x)));

  return {
    chain: "solana",
    txHash,
    accountKeys,
    signerAddresses,
    preNativeBalances,
    postNativeBalances,
    preTokenBalances,
    postTokenBalances,
    feeLamports: meta.fee == null ? undefined : BigInt(String(meta.fee)),
    feePayer: accountKeys[0],
  };
}
