import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import { OkxRouter } from "./okx.js";

test("OKX router signs request and converts base58 transaction data to base64", async () => {
  const originalFetch = globalThis.fetch;
  const rawTx = Buffer.from([1, 2, 3, 4]);
  let headers: HeadersInit | undefined;
  let requestedUrl = "";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    headers = init?.headers;
    return new Response(
      JSON.stringify({
        code: "0",
        data: [
          {
            tx: { data: bs58.encode(rawTx) },
            routerResult: { toTokenAmount: "42" },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const router = new OkxRouter(
      "https://www.okx.com",
      "key",
      "secret",
      "pass",
      "project",
    );
    const result = await router.swap({
      fromTokenAddress: "from",
      toTokenAddress: "to",
      amount: 123n,
      slippageBps: 300,
      userWalletAddress: "wallet",
    });

    assert.equal(result.transactionBase64, rawTx.toString("base64"));
    assert.equal(result.outAmount, "42");
    assert.match(requestedUrl, /\/api\/v5\/dex\/aggregator\/swap\?/);
    assert.equal((headers as Record<string, string>)["OK-ACCESS-KEY"], "key");
    assert.ok((headers as Record<string, string>)["OK-ACCESS-SIGN"]);
    assert.equal((headers as Record<string, string>)["OK-ACCESS-PROJECT"], "project");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OKX router refuses calls when credentials are missing", async () => {
  const router = new OkxRouter("https://www.okx.com");
  await assert.rejects(
    () =>
      router.swap({
        fromTokenAddress: "from",
        toTokenAddress: "to",
        amount: 1n,
        slippageBps: 100,
        userWalletAddress: "wallet",
      }),
    /OKX_NOT_CONFIGURED/,
  );
});
