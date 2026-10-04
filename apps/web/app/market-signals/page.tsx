"use client";

import { useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

type MarketSignal = {
  id: string;
  token_mint: string;
  symbol?: string | null;
  name?: string | null;
  price_usd: number | null;
  liquidity_usd: number | null;
  market_cap_usd: number | null;
  volume_h1_usd: number | null;
  txns_h1: number | null;
  age_minutes: number | null;
  price_change_m5_pct: number | null;
  price_change_h1_pct: number | null;
  signal_score: number;
  recommendation: string;
  buy_reasons: string[];
  risk_reasons: string[];
  avoid_reasons: string[];
  entry_plan: string[];
  exit_plan: string[];
  quality: any;
  sources: string[];
  created_at: string;
};

type Feed = {
  buyWatchlist: MarketSignal[];
  avoidList: MarketSignal[];
  all: MarketSignal[];
  stats: { snapshotCount: number; tokenCount: number; lastScanAt: string | null };
};

async function request(path: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as any) };
  if (init?.body != null && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { ...init, credentials: "include", headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export default function MarketSignalsPage() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deepChecks, setDeepChecks] = useState("10");
  const [maxTokens, setMaxTokens] = useState("20");

  const topChanged = useMemo(() => feed?.all.slice(0, 12) ?? [], [feed]);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setBusy(true);
    setMessage("");
    try {
      setFeed((await request("/api/market-signals?limit=50")) as Feed);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function scanNow() {
    setBusy(true);
    setMessage("");
    try {
      const result = await request("/api/market-signals/scan", {
        method: "POST",
        body: JSON.stringify({ maxTokens: Number(maxTokens), deepCheckTokens: Number(deepChecks) }),
      });
      setMessage(`Scan complete: ${result.saved ?? 0} saved, ${result.deepChecked ?? 0} deep checked.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell marketPage">
      <header>
        <div>
          <div className="eyebrow">COPYBOT</div>
          <h1>Market signals</h1>
          <p className="muted compactText">Dynamic token watchlist with DexScreener market data, Helius buyer quality, holder concentration checks, and exit guidance.</p>
        </div>
        <div className="actions">
          <a className="navButton" href="/">Trading control</a>
          <button className="secondary" disabled={busy} onClick={() => void load()}>Refresh</button>
        </div>
      </header>

      {message && <div className={message.includes("Error") ? "error" : "notice"}>{message}</div>}

      <section className="card marketToolbar">
        <label>Max tokens <input type="number" min="5" max="50" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} /></label>
        <label>Helius deep checks <input type="number" min="0" max="30" value={deepChecks} onChange={(e) => setDeepChecks(e.target.value)} /></label>
        <button disabled={busy} onClick={() => void scanNow()}>{busy ? "Scanning…" : "Scan now"}</button>
        <span className="muted">Last scan: {feed?.stats.lastScanAt ? new Date(feed.stats.lastScanAt).toLocaleString() : "never"}</span>
      </section>

      <section className="stats">
        <div className="card stat"><span>Buy/watch</span><strong>{feed?.buyWatchlist.length ?? 0}</strong></div>
        <div className="card stat"><span>Avoid list</span><strong>{feed?.avoidList.length ?? 0}</strong></div>
        <div className="card stat"><span>Tokens tracked</span><strong>{feed?.stats.tokenCount ?? 0}</strong></div>
        <div className="card stat"><span>Snapshots</span><strong>{feed?.stats.snapshotCount ?? 0}</strong></div>
      </section>

      <section className="marketGrid">
        <SignalColumn title="Top coins to watch" empty="No buy/watch signals yet." signals={feed?.buyWatchlist ?? []} />
        <SignalColumn title="10 coins not to buy" empty="No avoid signals yet." signals={feed?.avoidList ?? []} />
      </section>

      <section className="card">
        <div className="sectionTitle"><h2>All latest signals</h2><span>{topChanged.length}</span></div>
        <div className="marketList">
          {topChanged.map((signal) => <SignalCard key={signal.id} signal={signal} />)}
          {!topChanged.length && <p className="muted">No market signals yet. Run a scan.</p>}
        </div>
      </section>
    </main>
  );
}

function SignalColumn({ title, empty, signals }: { title: string; empty: string; signals: MarketSignal[] }) {
  return (
    <section className="card">
      <div className="sectionTitle"><h2>{title}</h2><span>{signals.length}</span></div>
      <div className="marketList">
        {signals.map((signal) => <SignalCard key={signal.id} signal={signal} compact />)}
        {!signals.length && <p className="muted">{empty}</p>}
      </div>
    </section>
  );
}

function SignalCard({ signal, compact = false }: { signal: MarketSignal; compact?: boolean }) {
  const badge = recommendationClass(signal.recommendation);
  return (
    <article className="marketSignalCard">
      <div className="marketSignalHead">
        <div>
          <h3>{signal.symbol ?? shortAddress(signal.token_mint)}</h3>
          <p className="muted compactText">{signal.name ?? shortAddress(signal.token_mint)}</p>
        </div>
        <span className={`badge ${badge}`}>{signal.recommendation.replaceAll("_", " ")} · {Math.round(signal.signal_score)}/100</span>
      </div>
      <div className="marketMetrics">
        <span>Liquidity <b>{money(signal.liquidity_usd)}</b></span>
        <span>MCap <b>{money(signal.market_cap_usd)}</b></span>
        <span>1h Vol <b>{money(signal.volume_h1_usd)}</b></span>
        <span>1h Tx <b>{signal.txns_h1 ?? "—"}</b></span>
        <span>5m <b>{pct(signal.price_change_m5_pct)}</b></span>
        <span>1h <b>{pct(signal.price_change_h1_pct)}</b></span>
      </div>
      <details open={!compact} className="marketDetails">
        <summary>Breakdown, entry and exit plan</summary>
        <ReasonBlock title="Why it may be good" items={signal.buy_reasons} />
        <ReasonBlock title="Risks" items={signal.risk_reasons} />
        <ReasonBlock title="Why not to buy" items={signal.avoid_reasons} />
        <ReasonBlock title="Entry condition" items={signal.entry_plan} />
        <ReasonBlock title="When to sell / leave" items={signal.exit_plan} />
        <div className="marketQuality">
          <span>Helius buyers: <b>{signal.quality?.helius?.uniqueBuyers ?? "—"}</b></span>
          <span>Known good: <b>{signal.quality?.helius?.knownGoodWallets ?? "—"}</b></span>
          <span>Fee-payer risk: <b>{signal.quality?.helius?.suspiciousFeePayerSharePct == null ? "—" : `${signal.quality.helius.suspiciousFeePayerSharePct}%`}</b></span>
          <span>Top holder: <b>{signal.quality?.holders?.topHolderPct == null ? "—" : `${Number(signal.quality.holders.topHolderPct).toFixed(1)}%`}</b></span>
        </div>
      </details>
      <div className="marketSignalFooter">
        <span className="mono">{shortAddress(signal.token_mint)}</span>
        <a href={`https://dexscreener.com/solana/${signal.token_mint}`} target="_blank" rel="noreferrer">DexScreener</a>
      </div>
    </article>
  );
}

function ReasonBlock({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return <div className="marketReasons"><b>{title}</b><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
}

function recommendationClass(value: string) {
  if (value === "BUY_WATCH") return "live";
  if (value === "WAIT_FOR_PULLBACK" || value === "PAPER_ONLY") return "paper";
  return "danger";
}

function money(value: number | null) {
  if (value == null) return "—";
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function pct(value: number | null) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function shortAddress(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}
