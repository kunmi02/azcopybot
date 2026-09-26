import type { FomoIdentity } from "../types.js";

export class FomoScanClient {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {}

  async resolveHandle(rawHandle: string): Promise<FomoIdentity> {
    if (!this.apiKey) throw new Error("FOMOSCAN_API_KEY_NOT_CONFIGURED");
    const handle = rawHandle.replace(/^@/, "").trim();
    if (!handle) throw new Error("FOMO handle is required");
    const res = await fetch(`${this.baseUrl}/v2/user/handle/${encodeURIComponent(handle)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
    });
    if (res.status === 404) throw new Error(`FOMOSCAN_NOT_OBSERVED:${handle}`);
    if (res.status === 402) throw new Error("FOMOSCAN_QUOTA_EXCEEDED");
    if (res.status === 429) throw new Error("FOMOSCAN_RATE_LIMITED");
    if (!res.ok) throw new Error(`FOMOSCAN_HTTP_${res.status}:${await res.text()}`);

    const body: any = await res.json();
    const data = body.data ?? body;
    return {
      id: String(data.id),
      handle: String(data.handle ?? handle),
      name: data.name ?? null,
      solanaAddress: data.solanaAddress ?? null,
      evmAddress: data.evmAddress ?? null,
    };
  }
}
