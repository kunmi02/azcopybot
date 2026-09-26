"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

type Dashboard = {
  user: any;
  wallet: any;
  positions: any[];
  traders: any[];
  executions: any[];
  walletBalances?: { sol: number | null; usdc: number | null } | null;
};

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

  useEffect(() => setToken(localStorage.getItem("copybot_session")), []);
  useEffect(() => { if (token) void load(); }, [token]);

  async function load() {
    try { setData(await request("/api/dashboard", token)); }
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
    if (!confirm(`Exit ${percentage}% of this position?`)) return;
    setBusy(true); setMessage("");
    try {
      await request(`/api/positions/${positionId}/exit`, token, { method: "POST", body: JSON.stringify({ percentage }) });
      await load();
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function updateConfig(id: string, patch: any) {
    setBusy(true); setMessage("");
    try { await request(`/api/configs/${id}`, token, { method: "PATCH", body: JSON.stringify(patch) }); await load(); }
    catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  async function unfollow(id: string, label: string) {
    if (!confirm(`Stop following ${label}?`)) return;
    setBusy(true); setMessage("");
    try { await request(`/api/configs/${id}`, token, { method: "DELETE" }); await load(); }
    catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  }

  const paperCount = useMemo(() => data?.positions.filter((p) => p.mode === "paper").length ?? 0, [data]);

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
      <div className="actions"><span className={data.user.paused ? "badge warn" : "badge live"}>{data.user.paused ? "PAUSED" : "ACTIVE"}</span><button className="secondary" onClick={() => pause(!data.user.paused)}>{data.user.paused ? "Resume" : "Pause entries"}</button></div>
    </header>

    {message && <div className="notice">{message}</div>}

    <section className="stats">
      <div className="card stat"><span>Open positions</span><strong>{data.positions.length}</strong></div>
      <div className="card stat"><span>Paper positions</span><strong>{paperCount}</strong></div>
      <div className="card stat"><span>Following</span><strong>{data.traders.length}</strong></div>
      <div className="card stat"><span>Copy wallet</span><strong className="mono small">{data.wallet?.public_address ? `${data.wallet.public_address.slice(0, 5)}…${data.wallet.public_address.slice(-5)}` : "Not configured"}</strong>{data.walletBalances && <small className="muted">{data.walletBalances.usdc == null ? "USDC ?" : `$${data.walletBalances.usdc.toFixed(2)} USDC`} · {data.walletBalances.sol == null ? "SOL ?" : `${data.walletBalances.sol.toFixed(4)} SOL`}</small>}</div>
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
      <div className="sectionTitle"><h2>Following</h2><span>{data.traders.length} configs</span></div>
      <div className="table">
        {data.traders.map((t) => <div className="row" key={t.config_id}>
          <div><b>{t.handle ? `@${t.handle}` : t.display_name}</b><div className="muted mono">{t.wallets?.map((w:any) => `${w.chain}:${String(w.address).slice(0,8)}…`).join(" · ")}</div></div>
          <label>$ / entry<input type="number" min="1" step="1" defaultValue={t.trade_amount_usd} onBlur={(e) => void updateConfig(t.config_id, { tradeAmountUsd: Number(e.target.value) })} /></label>
          <label>TP %<input type="number" defaultValue={t.take_profit_pct ?? ""} onBlur={(e) => void updateConfig(t.config_id, { takeProfitPct: e.target.value ? Number(e.target.value) : null })} /></label>
          <label>SL %<input type="number" defaultValue={t.stop_loss_pct ?? ""} onBlur={(e) => void updateConfig(t.config_id, { stopLossPct: e.target.value ? Number(e.target.value) : null })} /></label>
          <span className={t.dry_run ? "badge paper" : "badge danger"}>{t.dry_run ? "PAPER" : "LIVE"}</span>
          <div className="actions">
            {t.dry_run ? <button className="danger" onClick={() => { if (confirm("Enable LIVE trading for this trader? Real funds may be spent.")) void updateConfig(t.config_id, { dryRun: false, confirmLive: true }); }}>Enable live</button> : <button className="secondary" onClick={() => updateConfig(t.config_id, { dryRun: true })}>Paper mode</button>}
            <button className="secondary" onClick={() => void unfollow(t.config_id, t.handle ? `@${t.handle}` : t.display_name)}>Unfollow</button>
          </div>
        </div>)}
        {!data.traders.length && <p className="muted">No traders yet.</p>}
      </div>
    </section>

    <section className="card">
      <div className="sectionTitle"><h2>Open positions</h2><span>{data.positions.length}</span></div>
      <div className="cards">
        {data.positions.map((p) => <article className="position" key={p.id}>
          <div className="positionHead"><b className="mono">{p.token.slice(0,8)}…</b><span className={p.mode === "paper" ? "badge paper" : "badge live"}>{p.mode.toUpperCase()}</span></div>
          <div className="positionNumbers"><span>Cost <b>${Number(p.cost_usd).toFixed(2)}</b></span><span>Value <b>{p.current_value_usd == null ? "—" : `$${Number(p.current_value_usd).toFixed(2)}`}</b></span><span>PnL <b className={Number(p.pnl_pct) >= 0 ? "buy" : "sell"}>{p.pnl_pct == null ? "—" : `${Number(p.pnl_pct).toFixed(1)}%`}</b></span></div>
          <p className="muted">{p.symbol ? `${p.symbol} · ` : ""}Entry ${Number(p.avg_entry_price).toPrecision(5)} · TP {p.take_profit_pct ?? "off"}% · SL {p.stop_loss_pct ?? "off"}%</p>
          <p className="muted">Source: {p.handle ? `@${p.handle}` : p.display_name}</p>
          <div className="actions"><button className="secondary" onClick={() => exit(p.id, 50)}>Sell 50%</button><button className="danger" onClick={() => exit(p.id, 100)}>Sell all</button></div>
        </article>)}
        {!data.positions.length && <p className="muted">No open positions.</p>}
      </div>
    </section>

    <section className="card">
      <div className="sectionTitle"><h2>Recent executions</h2><span>last 20</span></div>
      <div className="table compact">
        {data.executions.map((e) => <div className="row execution" key={e.id}><span className={e.side === "buy" ? "buy" : "sell"}>{e.side.toUpperCase()}</span><span className="mono">{e.token.slice(0,8)}…</span><span>{e.reason}</span><span>{e.actual_usd != null ? `$${Number(e.actual_usd).toFixed(2)}` : "—"}</span><span className="muted">{e.status}</span></div>)}
      </div>
    </section>
  </main>;
}
