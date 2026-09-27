"use client";

import { FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

type Dashboard = {
  user: any;
  wallet: any;
  positions: any[];
  traders: any[];
  inactiveTraders?: any[];
  executions: any[];
  activity: any[];
  walletBalances?: { sol: number | null; usdc: number | null } | null;
  walletReadiness?: { copyWallet: boolean; signer: boolean; jupiter: boolean; solReserve: boolean; usdcBalance: boolean };
};

type SystemHealth = {
  triton: string;
  telegram: string;
  watchedWallets: number;
  lastChainEventAt: string | null;
  solanaRpc?: { state: string; slot?: number; latencyMs?: number; error?: string };
  jupiter?: { state: string; baseUrl: string };
  fomoScan?: { state: string; baseUrl: string };
};

type TraderGroup = { key: string; label: string; items: any[] };

async function request(path: string, token: string | null, init?: RequestInit) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers as any) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [data, setData] = useState<Dashboard | null>(null);
  const [handle, setHandle] = useState("");
  const [fomoPreview, setFomoPreview] = useState<any | null>(null);
  const [walletLabel, setWalletLabel] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<any[]>([]);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [feedStatus, setFeedStatus] = useState<"connecting" | "live" | "disconnected">("connecting");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => setToken(localStorage.getItem("copybot_session")), []);
  useEffect(() => { if (token) { void load(); void loadHealth(); } }, [token]);
  useEffect(() => {
    if (!token) return;
    setFeedStatus("connecting");
    const events = new EventSource(`${API}/api/events?token=${encodeURIComponent(token)}`);
    events.addEventListener("ready", () => setFeedStatus("live"));
    events.addEventListener("activity", (raw) => {
      const event = JSON.parse((raw as MessageEvent).data);
      setActivity((current) => [event, ...current].slice(0, 80));
      setLastUpdated(new Date());
    });
    events.onerror = () => setFeedStatus("disconnected");
    return () => events.close();
  }, [token]);
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => void loadHealth(), 10_000);
    return () => clearInterval(timer);
  }, [token]);

  async function load() {
    try {
      const dashboard = await request("/api/dashboard", token);
      setData(dashboard);
      setActivity(dashboard.activity ?? []);
      setLastUpdated(new Date());
    }
    catch (e) { setMessage(String(e)); }
  }

  async function loadHealth() {
    try { setHealth(await request("/api/system-health", token)); }
    catch (e) { setMessage(String(e)); }
  }

  async function login(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await request("/auth/code", null, { method: "POST", body: JSON.stringify({ code }) });
      localStorage.setItem("copybot_session", result.token);
      setToken(result.token);
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function resolveFomo(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMessage(""); setFomoPreview(null);
    try {
      const result = await request("/api/traders/fomo/resolve", token, { method: "POST", body: JSON.stringify({ handle }) });
      setFomoPreview(result);
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function confirmFomoFollow() {
    if (!fomoPreview?.identity?.handle) return;
    setBusy(true); setMessage("");
    try {
      await request("/api/traders/fomo", token, { method: "POST", body: JSON.stringify({ handle: fomoPreview.identity.handle }) });
      setHandle(""); setFomoPreview(null); await load();
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function followWallet(e: FormEvent) {
    e.preventDefault();
    if (!confirm(`Follow ${walletLabel || "this trader"} at ${walletAddress}?`)) return;
    setBusy(true); setMessage("");
    try {
      await request("/api/traders/wallet", token, { method: "POST", body: JSON.stringify({ label: walletLabel || "Wallet trader", chain: "solana", address: walletAddress }) });
      setWalletLabel(""); setWalletAddress(""); await load();
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function pause(paused: boolean) {
    await request(`/api/trading/${paused ? "pause" : "resume"}`, token, { method: "POST", body: "{}" });
    await load();
  }

  async function exit(positionId: string, percentage: number) {
    const position = data?.positions.find((p) => p.id === positionId);
    const label = position?.symbol ?? position?.token ?? "this position";
    const value = position?.current_value_usd == null ? "unknown" : `$${(Number(position.current_value_usd) * (percentage / 100)).toFixed(2)}`;
    if (!confirm(`${position?.mode === "live" ? "Sell" : "Close"} ${percentage}% of ${label}?\nEstimated value: ${value}\nCurrent PnL: ${position?.pnl_pct == null ? "unknown" : `${Number(position.pnl_pct).toFixed(1)}%`}`)) return;
    setBusy(true); setMessage("");
    try {
      await request(`/api/positions/${positionId}/exit`, token, { method: "POST", body: JSON.stringify({ percentage }) });
      await load();
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function updateConfig(id: string, patch: any) {
    setBusy(true); setMessage("");
    try {
      await request(`/api/configs/${id}`, token, { method: "PATCH", body: JSON.stringify(patch) });
      await load();
      setMessage("Settings saved.");
    }
    catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function unfollow(id: string, label: string) {
    if (!confirm(`Unfollow ${label}?\n\nThis stops future signals for this trader. Existing positions remain visible and manageable.`)) return;
    setBusy(true); setMessage("");
    try {
      const result = await request(`/api/configs/${id}`, token, { method: "DELETE" });
      const removedId = result.removedConfigId ?? id;
      setData((current) => current ? { ...current, traders: current.traders.filter((trader) => trader.config_id !== removedId) } : current);
      setMessage(`Unfollowed ${result.trader ?? label}. Existing positions were not closed.`);
      await load();
    }
    catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function followAgain(id: string, label: string) {
    setBusy(true); setMessage("");
    try {
      await request(`/api/configs/${id}`, token, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
      setMessage(`Following ${label} again. New entries start in paper mode unless you enable live.`);
      await load();
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function setAllMode(live: boolean) {
    if (live) {
      if (!confirm(`Enable LIVE for all ${data?.traders.length ?? 0} followed trader${data?.traders.length === 1 ? "" : "s"}?\n\nFuture qualifying entries for any followed trader can spend real funds from your copy wallet.`)) return;
    } else if (!confirm("Return all followed traders to PAPER mode?\n\nFuture entries become simulated. Existing live positions remain real and manageable.")) return;
    setBusy(true); setMessage("");
    try {
      const result = await request(`/api/trading/${live ? "live-all" : "paper-all"}`, token, { method: "POST", body: JSON.stringify(live ? { confirmLive: true } : {}) });
      setMessage(live ? `LIVE enabled for ${result.updated} followed trader${result.updated === 1 ? "" : "s"}.` : `Paper mode enabled for ${result.updated} followed trader${result.updated === 1 ? "" : "s"}.`);
      await load();
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  const paperCount = useMemo(() => data?.positions.filter((p) => p.mode === "paper").length ?? 0, [data]);
  const livePositions = useMemo(() => data?.positions.filter((p) => p.mode === "live") ?? [], [data]);
  const paperPositions = useMemo(() => data?.positions.filter((p) => p.mode === "paper") ?? [], [data]);
  const liveReady = Boolean(data?.walletReadiness && Object.values(data.walletReadiness).every(Boolean));

  if (!token) {
    return <main className="center"><section className="login card">
      <div className="eyebrow">PRIVATE COPY TRADING</div>
      <h1>CopyBot</h1>
      <p>Send <code>/login</code> to your Telegram bot, then enter the one-time code here.</p>
      <form onSubmit={login} className="stack">
        <input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
        <button disabled={busy || code.length !== 6}>Sign in</button>
      </form>
      {message && <p className="error">{message}</p>}
    </section></main>;
  }

  if (!data) return <main className="center"><p>Loading…</p></main>;

  return <main className="shell">
    <header>
      <div><div className="eyebrow">COPYBOT</div><h1>Trading control</h1></div>
      <div className="actions"><span className={data.user.paused ? "badge warn" : "badge live"}>{data.user.paused ? "NEW ENTRIES PAUSED" : "ACTIVE"}</span><button className="secondary" onClick={() => pause(!data.user.paused)}>{data.user.paused ? "Resume entries" : "Pause all new entries"}</button><button className="secondary" disabled={busy || !data.traders.length} onClick={() => void setAllMode(false)}>Paper all</button><button className="danger" disabled={busy || !liveReady || !data.traders.length} title={liveReady ? "" : "Complete wallet readiness before enabling live"} onClick={() => void setAllMode(true)}>Live all</button></div>
    </header>

    {message && <div className="notice">{message}</div>}

    <section className="stats">
      <div className="card stat"><span>Open positions</span><strong>{data.positions.length}</strong></div>
      <div className="card stat"><span>Paper positions</span><strong>{paperCount}</strong></div>
      <div className="card stat"><span>Following</span><strong>{data.traders.length}</strong></div>
      <div className="card stat"><span>Copy wallet</span><strong className="mono small">{data.wallet?.public_address ? `${data.wallet.public_address.slice(0, 5)}…${data.wallet.public_address.slice(-5)}` : "Not configured"}</strong>{data.walletBalances && <small className="muted">{data.walletBalances.usdc == null ? "USDC ?" : `$${data.walletBalances.usdc.toFixed(2)} USDC`} · {data.walletBalances.sol == null ? "SOL ?" : `${data.walletBalances.sol.toFixed(4)} SOL`}</small>}</div>
    </section>

    <section className="opsGrid">
      <div className="card">
        <div className="sectionTitle"><h2>System health</h2><span>{feedStatus === "live" ? `Live${lastUpdated ? ` · updated ${timeAgo(lastUpdated)}` : ""}` : feedStatus}</span></div>
        <div className="healthGrid">
          <HealthItem label="Triton stream" state={health?.triton ?? "unknown"} />
          <HealthItem label="Solana RPC" state={health?.solanaRpc?.state ?? "unknown"} detail={health?.solanaRpc?.latencyMs == null ? undefined : `${health.solanaRpc.latencyMs}ms`} />
          <HealthItem label="Telegram" state={health?.telegram ?? "unknown"} />
          <HealthItem label="Jupiter" state={health?.jupiter?.state ?? "unknown"} />
          <HealthItem label="Watched wallets" state={health?.watchedWallets ? "healthy" : "unknown"} detail={String(health?.watchedWallets ?? 0)} />
          <HealthItem label="Last chain event" state={health?.lastChainEventAt ? "healthy" : "unknown"} detail={health?.lastChainEventAt ? timeAgo(new Date(health.lastChainEventAt)) : "none"} />
        </div>
      </div>
      <div className="card">
        <div className="sectionTitle"><h2>Wallet readiness</h2><span>{liveReady ? "Ready for live" : "Live disabled"}</span></div>
        <div className="healthGrid">
          <HealthItem label="Copy wallet" state={data.walletReadiness?.copyWallet ? "healthy" : "missing"} />
          <HealthItem label="Signer" state={data.walletReadiness?.signer ? "healthy" : "missing"} />
          <HealthItem label="USDC" state={data.walletReadiness?.usdcBalance ? "healthy" : "missing"} detail={data.walletBalances?.usdc == null ? undefined : `$${data.walletBalances.usdc.toFixed(2)}`} />
          <HealthItem label="SOL reserve" state={data.walletReadiness?.solReserve ? "healthy" : "missing"} detail={data.walletBalances?.sol == null ? undefined : `${data.walletBalances.sol.toFixed(4)} SOL`} />
          <HealthItem label="Jupiter key" state={data.walletReadiness?.jupiter ? "healthy" : "missing"} />
        </div>
      </div>
      <div className="card">
        <div className="sectionTitle"><h2>Activity feed</h2><span>{activity.length} recent</span></div>
        <div className="activityList">
          {activity.slice(0, 12).map((event) => <div className={`activity ${event.severity ?? "info"}`} key={event.id}>
            <span>{formatEventTime(event.created_at)}</span>
            <b>{event.type?.replaceAll("_", " ")}</b>
            <p>{event.message}</p>
          </div>)}
          {!activity.length && <p className="muted">No activity yet. The feed will update as chain events, copies, skips, and errors happen.</p>}
        </div>
      </div>
    </section>

    <section className="grid2">
      <div className="card">
        <div className="sectionTitle"><h2>Follow FOMO trader</h2><span>via FomoScan identity</span></div>
        <form onSubmit={resolveFomo} className="inlineForm"><input placeholder="@handle" value={handle} onChange={(e) => { setHandle(e.target.value); setFomoPreview(null); }} /><button disabled={busy || !handle.trim()}>Resolve</button></form>
        {fomoPreview && <div className="preview">
          <b>@{fomoPreview.identity.handle}</b>
          <div className="muted mono">SOL: {fomoPreview.identity.solanaAddress || "not resolved"}</div>
          <div className="muted mono">EVM: {fomoPreview.identity.evmAddress || "not resolved"}</div>
          <div className="actions"><button disabled={busy || !fomoPreview.identity.solanaAddress} onClick={() => void confirmFomoFollow()}>Confirm & follow</button><button className="secondary" onClick={() => setFomoPreview(null)}>Cancel</button></div>
        </div>}
        <p className="muted">The handle is resolved once to verified Solana/EVM wallets. You confirm the wallet mapping before it is watched. V1 copies Solana entries.</p>
      </div>
      <div className="card">
        <div className="sectionTitle"><h2>Follow any Solana wallet</h2><span>platform-independent</span></div>
        <form onSubmit={followWallet} className="stack"><input placeholder="Label (e.g. GMGN whale)" value={walletLabel} onChange={(e) => setWalletLabel(e.target.value)} /><input className="mono" placeholder="Solana wallet address" value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} /><button disabled={busy || !walletAddress.trim()}>Follow wallet</button></form>
      </div>
    </section>

    <section className="card safetyCard">
      <div className="sectionTitle"><h2>Safety</h2><span>defaults</span></div>
      <p><b>Every new config starts in PAPER mode.</b> Live mode requires an explicit confirmation. The copy wallet is separate from your main wallet. Pause stops new copied entries while existing TP/SL protection remains active.</p>
    </section>

    <section className="card">
      <div className="sectionTitle"><h2>Leaders</h2><span>{data.traders.length} following · {data.inactiveTraders?.length ?? 0} inactive</span></div>
      <div className="leaderList">
        {data.traders.map((leader) => <LeaderCard
          key={leader.config_id}
          leader={leader}
          dashboard={data}
          active
          liveReady={liveReady}
          busy={busy}
          updateConfig={updateConfig}
          unfollow={unfollow}
          followAgain={followAgain}
          exit={exit}
        />)}
        {data.inactiveTraders?.map((leader) => <LeaderCard
          key={leader.config_id}
          leader={leader}
          dashboard={data}
          active={false}
          liveReady={liveReady}
          busy={busy}
          updateConfig={updateConfig}
          unfollow={unfollow}
          followAgain={followAgain}
          exit={exit}
        />)}
        {!data.traders.length && !(data.inactiveTraders?.length ?? 0) && <p className="muted">No leaders yet.</p>}
      </div>
    </section>
  </main>;
}

function PositionCard({ position: p, onExit }: { position: any; onExit: (id: string, percentage: number) => void }) {
  return <article className={`position ${p.mode}`} key={p.id}>
          <div className="positionHead"><b className="mono">{p.token.slice(0,8)}…</b><span className={p.mode === "paper" ? "badge paper" : "badge live"}>{p.mode.toUpperCase()}</span></div>
          <div className="positionNumbers"><span>Cost <b>${Number(p.cost_usd).toFixed(2)}</b></span><span>Value <b>{p.current_value_usd == null ? "—" : `$${Number(p.current_value_usd).toFixed(2)}`}</b></span><span>PnL <b className={Number(p.pnl_pct) >= 0 ? "buy" : "sell"}>{p.pnl_pct == null ? "—" : `${Number(p.pnl_pct).toFixed(1)}%`}</b></span></div>
          <p className="muted">{p.symbol ? `${p.symbol} · ` : ""}Entry ${Number(p.avg_entry_price).toPrecision(5)} · TP {p.take_profit_pct ?? "off"}% · SL {p.stop_loss_pct ?? "off"}%</p>
          <p className="muted">{tpSlDistance(p)}</p>
          <p className="muted">Source: {p.handle ? `@${p.handle}` : p.display_name}</p>
          <div className="actions sellActions">{[25, 50, 75, 100].map((percentage) => <button key={percentage} className={percentage === 100 ? "danger" : "secondary"} onClick={() => onExit(p.id, percentage)}>{p.mode === "live" ? "Sell" : "Close"} {percentage}%</button>)}</div>
        </article>;
}

function LeaderCard({ leader, dashboard, active, liveReady, busy, updateConfig, unfollow, followAgain, exit }: {
  leader: any;
  dashboard: Dashboard;
  active: boolean;
  liveReady: boolean;
  busy: boolean;
  updateConfig: (id: string, patch: any) => Promise<void>;
  unfollow: (id: string, label: string) => Promise<void>;
  followAgain: (id: string, label: string) => Promise<void>;
  exit: (positionId: string, percentage: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const t = leader;
  const [tradeAmountUsd, setTradeAmountUsd] = useState(String(t.trade_amount_usd));
  const [takeProfitPct, setTakeProfitPct] = useState(t.take_profit_pct == null ? "" : String(t.take_profit_pct));
  const [stopLossPct, setStopLossPct] = useState(t.stop_loss_pct == null ? "" : String(t.stop_loss_pct));
  const [copyTopups, setCopyTopups] = useState(Boolean(t.copy_topups));
  const label = t.handle ? `@${t.handle}` : t.display_name;
  const leaderPositions = dashboard.positions.filter((p) => p.trader_id === t.trader_id);
  const livePositions = leaderPositions.filter((p) => p.mode === "live");
  const paperPositions = leaderPositions.filter((p) => p.mode === "paper");
  const executions = dashboard.executions.filter((e) => e.trader_id === t.trader_id);

  async function saveSettings() {
    await updateConfig(t.config_id, {
      tradeAmountUsd: Number(tradeAmountUsd),
      takeProfitPct: takeProfitPct ? Number(takeProfitPct) : null,
      stopLossPct: stopLossPct ? Number(stopLossPct) : null,
      copyTopups,
    });
    setEditing(false);
  }

  function confirmLive() {
    if (!confirm(`Enable LIVE trading for ${label}?\n$${Number(t.trade_amount_usd).toFixed(2)} per entry\nTP: ${t.take_profit_pct ?? "off"}% · SL: ${t.stop_loss_pct ?? "off"}%\nCopy wallet: ${dashboard.wallet?.public_address ?? "not configured"}\nUSDC: ${dashboard.walletBalances?.usdc == null ? "unknown" : `$${dashboard.walletBalances.usdc.toFixed(2)}`}\nSOL: ${dashboard.walletBalances?.sol == null ? "unknown" : dashboard.walletBalances.sol.toFixed(4)}\n\nFuture qualifying entries can spend real funds.`)) return;
    void updateConfig(t.config_id, { dryRun: false, confirmLive: true });
  }

  return <article className={`leaderCard ${active ? "" : "inactiveLeader"}`}>
    <div className="leaderHead">
      <div>
        <h3>{label}</h3>
        <div className="muted mono">{t.wallets?.map((w:any) => `${w.chain}:${String(w.address).slice(0,8)}…`).join(" · ")}</div>
      </div>
      <div className="actions">
        <span className={!active ? "badge warn" : t.dry_run ? "badge paper" : "badge danger"}>{!active ? "UNFOLLOWED" : t.dry_run ? "PAPER: SIMULATE" : "LIVE: REAL FUNDS"}</span>
        {active ? <>
          {editing ? <>
            <button disabled={busy || !Number(tradeAmountUsd)} onClick={() => void saveSettings()}>Save settings</button>
            <button className="secondary" onClick={() => setEditing(false)}>Cancel</button>
          </> : <>
            <button className="secondary" onClick={() => setEditing(true)}>Edit settings</button>
            {t.dry_run ? <button className="danger" disabled={busy || !liveReady} title={liveReady ? "" : "Complete wallet readiness before enabling live"} onClick={confirmLive}>Enable live</button> : <button className="secondary" onClick={() => void updateConfig(t.config_id, { dryRun: true })}>Paper mode</button>}
            <button className="secondary" onClick={() => void unfollow(t.config_id, label)}>Unfollow</button>
          </>}
        </> : <button className="secondary" disabled={busy} onClick={() => void followAgain(t.config_id, label)}>Follow again</button>}
      </div>
    </div>

    <div className="leaderSettings">
      {editing ? <>
        <label>$ / entry<input type="number" min="1" step="1" value={tradeAmountUsd} onChange={(e) => setTradeAmountUsd(e.target.value)} /></label>
        <label>TP %<input type="number" value={takeProfitPct} onChange={(e) => setTakeProfitPct(e.target.value)} /></label>
        <label>SL %<input type="number" value={stopLossPct} onChange={(e) => setStopLossPct(e.target.value)} /></label>
        <label className="checkSetting"><input type="checkbox" checked={copyTopups} onChange={(e) => setCopyTopups(e.target.checked)} /> Copy top-ups as new $ amount buys</label>
      </> : <>
        <SettingValue label="$ / entry" value={`$${Number(t.trade_amount_usd).toFixed(2)}`} />
        <SettingValue label="TP" value={t.take_profit_pct == null ? "off" : `${t.take_profit_pct}%`} />
        <SettingValue label="SL" value={t.stop_loss_pct == null ? "off" : `${t.stop_loss_pct}%`} />
        <SettingValue label="Top-ups" value={t.copy_topups ? "copy as new buy" : "skip"} />
      </>}
    </div>

    <div className="leaderColumns">
      <LeaderPanel title="Live positions" count={livePositions.length}>
        <div className="miniCards">{livePositions.map((p) => <PositionCard key={p.id} position={p} onExit={exit} />)}{!livePositions.length && <p className="muted">No live positions.</p>}</div>
      </LeaderPanel>
      <LeaderPanel title="Paper positions" count={paperPositions.length}>
        <div className="miniCards">{paperPositions.map((p) => <PositionCard key={p.id} position={p} onExit={exit} />)}{!paperPositions.length && <p className="muted">No paper positions.</p>}</div>
      </LeaderPanel>
      <LeaderPanel title="Recent executions" count={executions.length}>
        <div className="table compact leaderExecutions">
          {executions.slice(0, 6).map((e) => <div className="row execution" key={e.id}><span className={e.side === "buy" ? "buy" : "sell"}>{e.side.toUpperCase()}</span><span className="mono">{e.token.slice(0,8)}…</span><span>{e.reason}</span><span>{e.actual_usd != null ? `$${Number(e.actual_usd).toFixed(2)}` : "—"}</span><span className={String(e.status).startsWith("failed") ? "sell" : "muted"}>{e.status}</span><span>{e.tx_hash ? <a href={`https://solscan.io/tx/${e.tx_hash}`} target="_blank" rel="noreferrer">Solscan</a> : "—"}</span></div>)}
          {!executions.length && <p className="muted">No executions yet.</p>}
        </div>
      </LeaderPanel>
    </div>
  </article>;
}

function LeaderPanel({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section className="leaderPanel"><div className="leaderPanelHead"><b>{title}</b><span>{count}</span></div>{children}</section>;
}

function SettingValue({ label, value }: { label: string; value: string }) {
  return <div className="settingValue"><span>{label}</span><b>{value}</b></div>;
}

function HealthItem({ label, state, detail }: { label: string; state: string; detail?: string }) {
  const className = state === "healthy" || state === "configured" ? "good" : state === "down" || state === "missing_api_key" ? "bad" : "warn";
  return <div className="healthItem"><span>{label}</span><b className={className}>{state}</b>{detail && <small>{detail}</small>}</div>;
}

function formatEventTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function timeAgo(date: Date) {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function tpSlDistance(p: any) {
  if (p.pnl_pct == null) return "TP/SL distance unavailable until pricing loads.";
  const pnl = Number(p.pnl_pct);
  const tp = p.take_profit_pct == null ? "TP off" : `TP ${Number(p.take_profit_pct).toFixed(1)}% · ${(Number(p.take_profit_pct) - pnl).toFixed(1)}% remaining`;
  const sl = p.stop_loss_pct == null ? "SL off" : `SL -${Number(p.stop_loss_pct).toFixed(1)}% · ${(pnl + Number(p.stop_loss_pct)).toFixed(1)}% buffer`;
  return `PnL ${pnl.toFixed(1)}% | ${tp} | ${sl}`;
}

function groupByTrader(items: any[]): TraderGroup[] {
  const groups = new Map<string, TraderGroup>();
  for (const item of items) {
    const key = String(item.trader_id ?? item.traderId ?? item.display_name ?? item.handle ?? "unknown");
    const label = item.handle ? `@${item.handle}` : item.display_name ?? "Unknown trader";
    const group = groups.get(key) ?? ({ key, label, items: [] } as TraderGroup);
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}
