let requestId = 1;

export class SolanaRpc {
  constructor(readonly url: string) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
    });
    const body: any = await res.json();
    if (body.error) {
      const logs = Array.isArray(body.error?.data?.logs) ? `\n${body.error.data.logs.join("\n")}` : "";
      throw new Error(`${body.error.message ?? `RPC ${method} failed`}${logs}`);
    }
    return body.result as T;
  }

  async tokenDecimals(mint: string): Promise<number> {
    const result: any = await this.call("getTokenSupply", [mint, { commitment: "processed" }]);
    return Number(result.value.decimals);
  }

  async solBalance(address: string): Promise<bigint> {
    const result: any = await this.call("getBalance", [address, { commitment: "processed" }]);
    return BigInt(result.value);
  }

  async tokenBalanceRaw(owner: string, mint: string): Promise<bigint> {
    const result: any = await this.call("getTokenAccountsByOwner", [
      owner, { mint }, { encoding: "jsonParsed", commitment: "processed" },
    ]);
    let total = 0n;
    for (const item of result?.value ?? []) {
      const amount = item?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0";
      total += BigInt(String(amount));
    }
    return total;
  }

  async signatureStatus(signature: string) {
    const result: any = await this.call("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    return result?.value?.[0] ?? null;
  }

  async tradeDelta(signature: string, owner: string, tokenMint: string, quoteMint: string) {
    const tx: any = await this.call("getTransaction", [signature, {
      encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0,
    }]);
    if (!tx?.meta) return null;
    const aggregate = (balances: any[], mint: string) => {
      let amount = 0n; let decimals = 0;
      for (const b of balances ?? []) {
        if (b.owner !== owner || b.mint !== mint) continue;
        amount += BigInt(String(b.uiTokenAmount?.amount ?? "0"));
        decimals = Number(b.uiTokenAmount?.decimals ?? decimals);
      }
      return { amount, decimals };
    };
    const tokenPre = aggregate(tx.meta.preTokenBalances, tokenMint);
    const tokenPost = aggregate(tx.meta.postTokenBalances, tokenMint);
    const quotePre = aggregate(tx.meta.preTokenBalances, quoteMint);
    const quotePost = aggregate(tx.meta.postTokenBalances, quoteMint);
    return {
      tokenDeltaRaw: tokenPost.amount - tokenPre.amount,
      tokenDecimals: tokenPost.decimals || tokenPre.decimals,
      quoteDeltaRaw: quotePost.amount - quotePre.amount,
      quoteDecimals: quotePost.decimals || quotePre.decimals,
    };
  }

  async transferFeeBps(mint: string): Promise<number> {
    try {
      const result: any = await this.call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "processed" }]);
      const extensions: any[] = result?.value?.data?.parsed?.info?.extensions ?? [];
      const cfg = extensions.find((x) => x.extension === "transferFeeConfig")?.state ??
        extensions.find((x) => x.extension === "transferFeeConfig")?.transferFeeConfig;
      if (!cfg) return 0;
      const newer = Number(cfg.newerTransferFee?.transferFeeBasisPoints ?? 0);
      const older = Number(cfg.olderTransferFee?.transferFeeBasisPoints ?? 0);
      return Math.max(newer, older);
    } catch {
      // Per the source spec, lookup failure must not block the trade; value sanity is the backstop.
      return 0;
    }
  }
}
