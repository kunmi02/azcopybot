import Client, { CommitmentLevel, type SubscribeRequest } from "@triton-one/yellowstone-grpc";
import { normalizeYellowstoneTransaction } from "./normalize.js";
import type { TransactionSnapshot } from "../../detection/types.js";

export type SnapshotHandler = (snapshot: TransactionSnapshot) => Promise<void> | void;

export class SolanaGrpcWatcher {
  private stream: any;
  private stopped = true;
  private generation = 0;

  constructor(
    private readonly endpoint: string,
    private readonly xToken: string | undefined,
    private readonly onSnapshot: SnapshotHandler,
  ) {}

  async reconfigure(addresses: string[]) {
    this.generation += 1;
    const generation = this.generation;
    await this.stop();
    if (!addresses.length) return;
    this.stopped = false;

    const request: SubscribeRequest = {
      accounts: {}, slots: {}, transactionsStatus: {}, entry: {}, blocks: {}, blocksMeta: {},
      accountsDataSlice: [],
      transactions: {
        watched: { vote: false, failed: false, signature: undefined, accountInclude: addresses, accountExclude: [], accountRequired: [] },
      },
      commitment: CommitmentLevel.PROCESSED,
      ping: undefined,
    };

    const client = new Client(
      this.endpoint,
      this.xToken,
      { grpcMaxDecodingMessageSize: 64 * 1024 * 1024 },
      {
        enabled: true,
        backoff: { initialIntervalMs: 100, multiplier: 2, maxRetries: 10 },
        slotRetention: 250,
      },
    );
    await client.connect();

    // With auto-reconnect enabled the initial request is passed at stream creation.
    const stream = await client.subscribe(request);

    // Expensive production bug from the supplied spec: stop can land while connect/subscribe is in flight.
    if (this.stopped || generation !== this.generation) {
      stream.destroy();
      return;
    }
    this.stream = stream;

    stream.on("data", async (update: any) => {
      try {
        const snapshot = normalizeYellowstoneTransaction(update);
        if (snapshot) await this.onSnapshot(snapshot);
      } catch (error) {
        console.error("solana_update_failed", error);
      }
    });
    stream.on("error", (error: unknown) => console.error("solana_stream_error", error));
    stream.on("end", () => console.warn("solana_stream_ended"));
    stream.on("close", () => console.warn("solana_stream_closed"));
  }

  async stop() {
    this.stopped = true;
    const s = this.stream;
    this.stream = undefined;
    if (s) {
      try { s.destroy(); } catch { /* no-op */ }
    }
  }
}
