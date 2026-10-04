"use client";

import { useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

type Leader = {
  config_id: string;
  trader_id: string;
  handle?: string | null;
  display_name?: string | null;
  custom_label?: string | null;
  label?: string | null;
  enabled?: boolean;
  wallets?: Array<{ chain: string; address: string }>;
};

type Dashboard = {
  traders: Leader[];
  inactiveTraders?: Leader[];
};

type Execution = {
  id: string;
  token: string;
  side: "buy" | "sell";
  reason: string;
  requested_usd?: number | null;
  actual_usd?: number | null;
  token_qty?: string | number | null;
  execution_price?: number | null;
  tx_hash?: string | null;
  status: string;
  created_at: string;
  confirmed_at?: string | null;
};

type ExecutionsResponse = {
  leader: Leader;
  executions: Execution[];
  limit: number;
  offset: number;
  total: number;
  nextOffset: number | null;
};

async function request(path: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as any) };
  if (init?.body != null && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { ...init, credentials: "include", headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export default function LeaderExecutionsPage() {
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [limit, setLimit] = useState("100");
  const [result, setResult] = useState<ExecutionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const selectedLeader = useMemo(
    () => leaders.find((leader) => String(leader.config_id) === selectedConfigId),
    [leaders, selectedConfigId],
  );

  useEffect(() => {
    async function loadLeaders() {
      setLoading(true);
      setMessage("");
      try {
        const dashboard = (await request("/api/dashboard")) as Dashboard;
        const active = (dashboard.traders ?? []).map((leader) => ({ ...leader, enabled: true }));
        const inactive = (dashboard.inactiveTraders ?? []).map((leader) => ({ ...leader, enabled: false }));
        const all = [...active, ...inactive];
        setLeaders(all);
        const params = new URLSearchParams(window.location.search);
        const requested = params.get("configId");
        const firstId = requested && all.some((leader) => String(leader.config_id) === requested)
          ? requested
          : String(all[0]?.config_id ?? "");
        setSelectedConfigId(firstId);
        if (firstId) await fetchExecutions(firstId, limit, 0, false);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    }
    void loadLeaders();
  }, []);

  async function fetchExecutions(
    configId = selectedConfigId,
    selectedLimit = limit,
    offset = 0,
    append = false,
  ) {
    if (!configId) return;
    setLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ limit: selectedLimit, offset: String(offset) });
      const response = (await request(
        `/api/leaders/${encodeURIComponent(configId)}/executions?${params.toString()}`,
      )) as ExecutionsResponse;
      setResult((current) => {
        if (!append || !current) return response;
        const byId = new Map<string, Execution>();
        for (const execution of [...current.executions, ...response.executions]) byId.set(execution.id, execution);
        return { ...response, executions: [...byId.values()] };
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      if (!append) setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell execPage">
      <header>
        <div>
          <div className="eyebrow">COPYBOT</div>
          <h1>Leader executions</h1>
          <p className="muted compactText">View every buy, sell, retry, failure, and Solscan link recorded for a followed wallet.</p>
        </div>
        <div className="actions">
          <a className="navButton" href="/">Trading control</a>
          <a className="navButton" href="/leader-transactions">Leader txs</a>
        </div>
      </header>

      {message && <div className="error">{message}</div>}

      <section className="card txToolbar">
        <label>
          Leader
          <select
            value={selectedConfigId}
            onChange={(event) => {
              const next = event.target.value;
              setSelectedConfigId(next);
              setResult(null);
            }}
          >
            {!leaders.length && <option value="">No leaders found</option>}
            {leaders.map((leader) => (
              <option key={leader.config_id} value={leader.config_id}>
                {leaderLabel(leader)} · {leader.enabled ? "active" : "inactive"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Page size
          <select value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>
        <button disabled={loading || !selectedConfigId} onClick={() => void fetchExecutions(selectedConfigId, limit, 0, false)}>
          {loading ? "Fetching…" : "Fetch executions"}
        </button>
      </section>

      <section className="execSummaryGrid">
        <div className="card stat"><span>Leader</span><strong className="small">{leaderLabel(result?.leader ?? selectedLeader)}</strong></div>
        <div className="card stat"><span>Total executions</span><strong>{result?.total ?? "—"}</strong></div>
        <div className="card stat"><span>Shown</span><strong>{result?.executions.length ?? 0}</strong></div>
        <div className="card stat"><span>Wallet</span><strong className="small">{shortAddress(solanaWallet(result?.leader ?? selectedLeader) ?? "—")}</strong></div>
      </section>

      <section className="execList">
        {result?.executions.map((execution) => <ExecutionCard key={execution.id} execution={execution} />)}
        {result && !result.executions.length && <div className="card muted">No executions recorded for this leader yet.</div>}
      </section>

      {result?.nextOffset != null && (
        <div className="execPager">
          <button disabled={loading} onClick={() => void fetchExecutions(selectedConfigId, limit, result.nextOffset ?? 0, true)}>
            {loading ? "Loading…" : "Load more executions"}
          </button>
        </div>
      )}
    </main>
  );
}

function ExecutionCard({ execution }: { execution: Execution }) {
  const failed = execution.status.startsWith("failed:");
  return (
    <article className={`execFullCard ${failed ? "failed" : ""}`}>
      <div className="execFullTop">
        <div>
          <span className={execution.side === "buy" ? "buy" : "sell"}>{execution.side.toUpperCase()}</span>
          <h3>{execution.reason.replaceAll("_", " ").toLowerCase()}</h3>
          <p className="muted compactText">{new Date(execution.created_at).toLocaleString()} · {shortAddress(execution.token)}</p>
        </div>
        <strong>{execution.actual_usd == null ? execution.requested_usd == null ? "—" : `$${Number(execution.requested_usd).toFixed(2)} requested` : `$${Number(execution.actual_usd).toFixed(2)}`}</strong>
      </div>
      <div className="execFullMeta">
        <span>Status <b>{statusLabel(execution.status)}</b></span>
        <span>Token <b title={execution.token}>{shortAddress(execution.token)}</b></span>
        <span>Qty <b>{execution.token_qty == null ? "—" : Number(execution.token_qty).toLocaleString(undefined, { maximumSignificantDigits: 6 })}</b></span>
        <span>Price <b>{execution.execution_price == null ? "—" : `$${Number(execution.execution_price).toPrecision(6)}`}</b></span>
      </div>
      {execution.tx_hash ? <a href={`https://solscan.io/tx/${execution.tx_hash}`} target="_blank" rel="noreferrer">Solscan</a> : <span className="muted">No tx hash</span>}
      {failed && <pre>{execution.status.slice("failed:".length).replace(/^Error:\s*/, "")}</pre>}
    </article>
  );
}

function leaderLabel(leader?: Leader | null) {
  if (!leader) return "—";
  return leader.custom_label || leader.label || (leader.handle ? `@${leader.handle}` : leader.display_name) || "Leader";
}

function solanaWallet(leader?: Leader | null) {
  return leader?.wallets?.find((wallet) => wallet.chain === "solana")?.address ?? null;
}

function shortAddress(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function statusLabel(status: string) {
  if (status === "confirmed") return "Confirmed";
  if (status === "paper") return "Paper";
  if (status === "submitted_unknown") return "Status unknown";
  if (status.startsWith("failed:")) return "Failed";
  return status.replaceAll("_", " ");
}
