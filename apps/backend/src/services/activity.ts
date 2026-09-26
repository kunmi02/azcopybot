import type { Database } from "../db.js";

export type ActivitySeverity = "info" | "success" | "warning" | "error";

export type ActivityInput = {
  userId?: string | null;
  traderId?: string | null;
  positionId?: string | null;
  executionId?: string | null;
  type: string;
  severity?: ActivitySeverity;
  message: string;
  metadata?: Record<string, unknown>;
};

export type ActivityEvent = ActivityInput & {
  id: string;
  created_at: string;
  severity: ActivitySeverity;
};

type Listener = (event: ActivityEvent) => void;

export class ActivityService {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly db: Database) {}

  async emit(input: ActivityInput) {
    const event = await this.db.createActivityEvent({
      ...input,
      severity: input.severity ?? "info",
      metadata: input.metadata ?? {},
    });
    if (event.user_id) {
      for (const listener of this.listeners.get(event.user_id) ?? []) listener(mapActivityRow(event));
    }
    return event;
  }

  subscribe(userId: string, listener: Listener) {
    const listeners = this.listeners.get(userId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(userId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(userId);
    };
  }
}

function mapActivityRow(row: any): ActivityEvent {
  return {
    id: row.id,
    userId: row.user_id,
    traderId: row.trader_id,
    positionId: row.position_id,
    executionId: row.execution_id,
    type: row.type,
    severity: row.severity,
    message: row.message,
    metadata: row.metadata ?? {},
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
