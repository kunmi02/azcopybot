export type HealthState = "healthy" | "degraded" | "down" | "unknown";

export class HealthService {
  private triton: HealthState = "unknown";
  private telegram: HealthState = "unknown";
  private lastChainEventAt: string | null = null;
  private watchedWallets = 0;

  markTelegramStarted() {
    this.telegram = "healthy";
  }

  markTriton(state: HealthState) {
    this.triton = state;
  }

  markChainEvent() {
    this.lastChainEventAt = new Date().toISOString();
  }

  setWatchedWallets(count: number) {
    this.watchedWallets = count;
  }

  snapshot() {
    return {
      triton: this.triton,
      telegram: this.telegram,
      watchedWallets: this.watchedWallets,
      lastChainEventAt: this.lastChainEventAt,
    };
  }
}
