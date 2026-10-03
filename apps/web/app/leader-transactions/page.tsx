"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

type Dashboard = {
  traders: Leader[];
  inactiveTraders?: Leader[];
};

type Leader = {
  config_id: string;
  trader_id: string;
  handle?: string | null;
  display_name?: string | null;
  source?: string | null;
  enabled?: boolean;
  dry_run?: boolean;
  wallets?: Array<{ chain: string; address: string }>;
};

type LeaderTransaction = {
  signature: string;
  timestamp: string;
  type: string;
  source: string | null;
  feePayer: string | null;
  description: string | null;
  nativeTransfers: Array<{
    fromUserAccount: string | null;
    toUserAccount: string | null;
    amountSol: number | null;
  }>;
  tokenTransfers: Array<{
    mint: string | null;
    fromUserAccount: string | null;
    toUserAccount: string | null;
    tokenAmount: number | null;
    tokenStandard: string | null;
  }>;
};

type TransactionResponse = {
  leader: Leader;
  wallet: string;
  provider: string;
  limit: number;
  before?: string | null;
  nextBefore?: string | null;
  transactions: LeaderTransaction[];
};

async function request(path: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as any) };
  if (init?.body != null && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export default function LeaderTransactionsPage() {
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [limit, setLimit] = useState("50");
  const [result, setResult] = useState<TransactionResponse | null>(null);
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
        const active = (dashboard.traders ?? []).map((leader) => ({
          ...leader,
          enabled: true,
        }));
        const inactive = (dashboard.inactiveTraders ?? []).map((leader) => ({
          ...leader,
          enabled: false,
        }));
        const all = [...active, ...inactive];
        setLeaders(all);
        const firstSolanaLeader = all.find((leader) => solanaWallet(leader));
        const firstId = firstSolanaLeader ? String(firstSolanaLeader.config_id) : "";
        setSelectedConfigId(firstId);
        if (firstId) {
          await fetchTransactions(firstId, limit);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    }
    void loadLeaders();
  }, []);

  async function fetchTransactions(
    configId = selectedConfigId,
    selectedLimit = limit,
    options?: { before?: string | null; append?: boolean },
  ) {
    if (!configId) return;
    setLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ limit: selectedLimit });
      if (options?.before) params.set("before", options.before);
      const response = (await request(
        `/api/leaders/${encodeURIComponent(configId)}/transactions?${params.toString()}`,
      )) as TransactionResponse;
      setResult((current) => {
        if (!options?.append || !current) return response;
        const bySignature = new Map<string, LeaderTransaction>();
        for (const transaction of [
          ...current.transactions,
          ...response.transactions,
        ]) {
          bySignature.set(transaction.signature, transaction);
        }
        return {
          ...response,
          transactions: [...bySignature.values()],
        };
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      if (!options?.append) setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell txPage">
      <header>
        <div>
          <div className="eyebrow">COPYBOT</div>
          <h1>Leader transactions</h1>
          <p className="muted compactText">
            Fetch Solana transaction history for any leader you follow or previously followed.
          </p>
        </div>
        <div className="actions">
          <a className="navButton" href="/">
            Trading control
          </a>
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
            {leaders.map((leader) => {
              const wallet = solanaWallet(leader);
              return (
                <option
                  key={leader.config_id}
                  value={leader.config_id}
                  disabled={!wallet}
                >
                  {leaderLabel(leader)} · {wallet ? shortAddress(wallet) : "no solana wallet"} · {leader.enabled ? "active" : "inactive"}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          Limit
          <select value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>
        <button
          disabled={loading || !selectedConfigId || !solanaWallet(selectedLeader)}
          onClick={() => void fetchTransactions()}
        >
          {loading ? "Fetching…" : "Fetch transactions"}
        </button>
      </section>

      {selectedLeader && (
        <section className="card txLeaderSummary">
          <div>
            <span className="muted">Selected leader</span>
            <h2>{leaderLabel(selectedLeader)}</h2>
            <p className="mono small compactText">
              {solanaWallet(selectedLeader) ?? "No Solana wallet"}
            </p>
          </div>
          <span className={`badge ${selectedLeader.enabled ? "live" : "paper"}`}>
            {selectedLeader.enabled ? "active follow" : "inactive"}
          </span>
        </section>
      )}

      <section className="txResults">
        <div className="sectionTitle">
          <h2>Transactions</h2>
          <span>
            {result
              ? `${result.transactions.length} shown · ${result.provider} · ${shortAddress(result.wallet)}`
              : "No fetch yet"}
          </span>
        </div>
        <div className="txList">
          {result?.transactions.map((transaction) => (
            <TransactionCard key={transaction.signature} tx={transaction} />
          ))}
          {result && !result.transactions.length && (
            <div className="card muted">No transactions returned for this leader.</div>
          )}
          {result?.nextBefore && (
            <button
              className="secondary txLoadMore"
              disabled={loading}
              onClick={() =>
                void fetchTransactions(selectedConfigId, limit, {
                  before: result.nextBefore,
                  append: true,
                })
              }
            >
              {loading ? "Fetching older…" : "Load older transactions"}
            </button>
          )}
          {!result && !loading && (
            <div className="card muted">
              Pick a leader and fetch its transaction history.
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function TransactionCard({ tx }: { tx: LeaderTransaction }) {
  return (
    <article className="txCard">
      <div className="txCardHead">
        <div>
          <span className="muted">{formatDate(tx.timestamp)}</span>
          <h3>{titleCase(tx.type)}</h3>
        </div>
        <a href={`https://solscan.io/tx/${tx.signature}`} target="_blank" rel="noreferrer">
          Solscan
        </a>
      </div>
      {tx.description && <p>{tx.description}</p>}
      <div className="txMetaGrid">
        <span>
          Signature <b className="mono">{shortAddress(tx.signature)}</b>
        </span>
        <span>
          Source <b>{tx.source ?? "—"}</b>
        </span>
        <span>
          Fee payer <b className="mono">{tx.feePayer ? shortAddress(tx.feePayer) : "—"}</b>
        </span>
      </div>
      <details className="txTransfers">
        <summary>
          Transfers · {tx.tokenTransfers.length} token · {tx.nativeTransfers.length} SOL
        </summary>
        <div className="txTransferGrid">
          <div>
            <h4>Token transfers</h4>
            {tx.tokenTransfers.slice(0, 12).map((transfer, index) => (
              <TransferLine key={`${tx.signature}:token:${index}`}>
                <b>{formatAmount(transfer.tokenAmount)}</b>
                <span className="mono">{transfer.mint ? shortAddress(transfer.mint) : "unknown mint"}</span>
                <small>
                  {shortAddress(transfer.fromUserAccount)} → {shortAddress(transfer.toUserAccount)}
                </small>
              </TransferLine>
            ))}
            {!tx.tokenTransfers.length && <p className="muted">No token transfers.</p>}
          </div>
          <div>
            <h4>SOL transfers</h4>
            {tx.nativeTransfers.slice(0, 12).map((transfer, index) => (
              <TransferLine key={`${tx.signature}:native:${index}`}>
                <b>{formatAmount(transfer.amountSol)} SOL</b>
                <small>
                  {shortAddress(transfer.fromUserAccount)} → {shortAddress(transfer.toUserAccount)}
                </small>
              </TransferLine>
            ))}
            {!tx.nativeTransfers.length && <p className="muted">No SOL transfers.</p>}
          </div>
        </div>
      </details>
    </article>
  );
}

function TransferLine({ children }: { children: ReactNode }) {
  return <div className="txTransferLine">{children}</div>;
}

function leaderLabel(leader?: Leader | null) {
  if (!leader) return "Leader";
  return leader.handle ? `@${leader.handle}` : leader.display_name || "Leader";
}

function solanaWallet(leader?: Leader | null) {
  return leader?.wallets?.find((wallet) => wallet.chain === "solana")?.address ?? null;
}

function shortAddress(value?: string | null) {
  if (!value) return "—";
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatAmount(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return value.toLocaleString(undefined, { maximumSignificantDigits: 5 });
}
