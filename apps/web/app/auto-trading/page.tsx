"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

type AutoConfig = {
  enabledLive: boolean;
  tradeAmountUsd: number;
  maxOpenPositions: number;
  maxDailyBuys: number;
  dailyLossLimitUsd: number;
  maxTokenRiskScore: number;
  minLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  maxHoldSeconds: number | null;
  minHoldSeconds: number;
  tp1Pct: number | null;
  tp1SellPct: number;
  tp2Pct: number | null;
  tp2SellPct: number;
  tp3Pct: number | null;
  tp3SellPct: number;
  runnerPct: number;
  breakevenTriggerPct: number | null;
  trailingTriggerPct: number | null;
  trailingDistancePct: number | null;
  updatedAt?: string | null;
};

type Readiness = {
  ready: boolean;
  missing: string[];
  copyWallet: boolean;
  signer: boolean;
  jupiter: boolean;
  solReserve: boolean;
  usdcBalance: boolean;
  balances: { sol: number | null; usdc: number | null };
};

type AutoResponse = {
  config: AutoConfig;
  readiness: Readiness;
  status?: {
    autoEntryEngine: string;
    openAutoPositions: number;
    dailyAutoBuys: number;
    dailyRealizedPnlUsd: number;
  };
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

export default function AutoTradingPage() {
  const [config, setConfig] = useState<AutoConfig | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [status, setStatus] = useState<AutoResponse["status"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const readyText = useMemo(() => {
    if (!readiness) return "checking";
    if (readiness.ready) return "ready for live";
    return `missing ${readiness.missing.join(", ")}`;
  }, [readiness]);

  const stagedSellTotal = useMemo(() => {
    if (!config) return 0;
    return Number(config.tp1SellPct || 0) + Number(config.tp2SellPct || 0) + Number(config.tp3SellPct || 0) + Number(config.runnerPct || 0);
  }, [config]);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setBusy(true);
    setMessage("");
    try {
      const result = (await request("/api/auto-trading/config")) as AutoResponse;
      setConfig(result.config);
      setReadiness(result.readiness);
      setStatus(result.status ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function update<K extends keyof AutoConfig>(key: K, value: AutoConfig[K]) {
    setConfig((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!config) return;
    setBusy(true);
    setMessage("");
    try {
      const result = (await request("/api/auto-trading/config", {
        method: "PATCH",
        body: JSON.stringify({ ...config, enabledLive: false }),
      })) as AutoResponse;
      setConfig(result.config);
      setReadiness(result.readiness);
      setMessage("Autonomous trading settings saved. Live auto mode remains off.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function setLive(enabled: boolean) {
    if (!config) return;
    if (enabled) {
      const confirmed = confirm(
        `Enable AUTONOMOUS LIVE trading?\n\nThe bot will be allowed to open live positions from discovery signals without a leader buy.\n\nTrade size: $${Number(config.tradeAmountUsd).toFixed(2)}\nMax open auto positions: ${config.maxOpenPositions}\nMax daily buys: ${config.maxDailyBuys}\nDaily loss limit: $${Number(config.dailyLossLimitUsd).toFixed(2)}\nToken risk must be <= ${config.maxTokenRiskScore}/100\nMarket cap: $${Number(config.minMarketCapUsd).toLocaleString()} - $${Number(config.maxMarketCapUsd).toLocaleString()}\nHolding: min ${formatDuration(config.minHoldSeconds)}, max ${formatDuration(config.maxHoldSeconds)}\nStages: TP1 ${formatPercent(config.tp1Pct)} / sell ${config.tp1SellPct}%, TP2 ${formatPercent(config.tp2Pct)} / sell ${config.tp2SellPct}%, TP3 ${formatPercent(config.tp3Pct)} / sell ${config.tp3SellPct}%\nTrailing: after ${formatPercent(config.trailingTriggerPct)}, trail ${formatPercent(config.trailingDistancePct)}\n\nThis can spend real funds automatically.`,
      );
      if (!confirmed) return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = (await request("/api/auto-trading/config", {
        method: "PATCH",
        body: JSON.stringify({
          ...config,
          enabledLive: enabled,
          confirmLiveAuto: enabled,
        }),
      })) as AutoResponse;
      setConfig(result.config);
      setReadiness(result.readiness);
      setMessage(`Autonomous live trading ${enabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell autoPage">
      <header>
        <div>
          <div className="eyebrow">COPYBOT</div>
          <h1>Autonomous trading</h1>
          <p className="muted compactText">
            Configure live auto mode for discovery-approved tokens. These settings are separate from leader copy-trading.
          </p>
        </div>
        <div className="actions">
          <a className="navButton" href="/">Trading control</a>
        </div>
      </header>

      {message && <div className={message.startsWith("Error") ? "error" : "notice"}>{message}</div>}

      <section className="stats autoStats">
        <div className="card stat">
          <span>Live auto mode</span>
          <strong>{config?.enabledLive ? "ON" : "OFF"}</strong>
        </div>
        <div className="card stat">
          <span>Readiness</span>
          <strong className="small">{readyText}</strong>
        </div>
        <div className="card stat">
          <span>Copy wallet</span>
          <strong className="small">
            {readiness?.balances.usdc == null ? "USDC ?" : `$${readiness.balances.usdc.toFixed(2)}`} · {readiness?.balances.sol == null ? "SOL ?" : `${readiness.balances.sol.toFixed(4)} SOL`}
          </strong>
        </div>
        <div className="card stat">
          <span>Auto engine</span>
          <strong className="small">{status?.autoEntryEngine ?? "settings"}</strong>
        </div>
      </section>

      {config && (
        <form className="card autoForm" onSubmit={save}>
          <div className="sectionTitle">
            <h2>Guardrails</h2>
            <span>{config.updatedAt ? `updated ${new Date(config.updatedAt).toLocaleString()}` : "not saved yet"}</span>
          </div>

          <div className="autoSubsection">
            <h3>Entry limits</h3>
            <p>These stop the auto engine from over-trading while it is selecting discovery-approved tokens.</p>
            <div className="autoGrid">
              <NumberField label="$ per auto buy" value={config.tradeAmountUsd} min={0.1} step={0.1} onChange={(v) => update("tradeAmountUsd", v)} />
              <NumberField label="Max open auto positions" value={config.maxOpenPositions} min={1} step={1} onChange={(v) => update("maxOpenPositions", v)} />
              <NumberField label="Max daily auto buys" value={config.maxDailyBuys} min={1} step={1} onChange={(v) => update("maxDailyBuys", v)} />
              <NumberField label="Daily loss limit $" value={config.dailyLossLimitUsd} min={0.1} step={0.1} onChange={(v) => update("dailyLossLimitUsd", v)} />
              <NumberField label="Max token risk score" value={config.maxTokenRiskScore} min={0} max={100} step={1} onChange={(v) => update("maxTokenRiskScore", v)} />
              <NumberField label="Min liquidity $" value={config.minLiquidityUsd} min={0} step={100} onChange={(v) => update("minLiquidityUsd", v)} />
              <NumberField label="Min market cap $" value={config.minMarketCapUsd} min={0} step={100} onChange={(v) => update("minMarketCapUsd", v)} />
              <NumberField label="Max market cap $" value={config.maxMarketCapUsd} min={0} step={100} onChange={(v) => update("maxMarketCapUsd", v)} />
            </div>
          </div>

          <div className="autoSubsection">
            <h3>Hard exits</h3>
            <p>These are direct exit rules. Leave either percent blank to disable that rule.</p>
            <div className="autoGrid">
              <OptionalNumberField label="Take profit %" value={config.takeProfitPct} min={0} step={1} onChange={(v) => update("takeProfitPct", v)} />
              <OptionalNumberField label="Stop loss %" value={config.stopLossPct} min={0} max={100} step={1} onChange={(v) => update("stopLossPct", v)} />
              <HoldSelect label="Minimum hold" value={config.minHoldSeconds} allowOff={false} onChange={(v) => update("minHoldSeconds", v ?? 0)} />
              <HoldSelect label="Max hold" value={config.maxHoldSeconds} allowOff onChange={(v) => update("maxHoldSeconds", v)} />
            </div>
          </div>

          <div className="autoSubsection">
            <h3>Staged profit taking</h3>
            <p>Profit percentages are from entry. 100% means 2x, 200% means 3x. The runner is the portion left for a larger move.</p>
            <div className="autoGrid">
              <OptionalNumberField label="TP1 trigger %" value={config.tp1Pct} min={0} step={1} onChange={(v) => update("tp1Pct", v)} />
              <NumberField label="TP1 sell %" value={config.tp1SellPct} min={0} max={100} step={1} onChange={(v) => update("tp1SellPct", v)} />
              <OptionalNumberField label="TP2 trigger %" value={config.tp2Pct} min={0} step={1} onChange={(v) => update("tp2Pct", v)} />
              <NumberField label="TP2 sell %" value={config.tp2SellPct} min={0} max={100} step={1} onChange={(v) => update("tp2SellPct", v)} />
              <OptionalNumberField label="TP3 trigger %" value={config.tp3Pct} min={0} step={1} onChange={(v) => update("tp3Pct", v)} />
              <NumberField label="TP3 sell %" value={config.tp3SellPct} min={0} max={100} step={1} onChange={(v) => update("tp3SellPct", v)} />
              <NumberField label="Runner %" value={config.runnerPct} min={0} max={100} step={1} onChange={(v) => update("runnerPct", v)} />
            </div>
            <div className={stagedSellTotal > 100 ? "autoHint warning" : "autoHint"}>
              Planned staged sell + runner total: {stagedSellTotal.toFixed(0)}%. Keep it at 100% or below.
            </div>
          </div>

          <div className="autoSubsection">
            <h3>Protect winners</h3>
            <p>Break-even protects the original capital after a move. Trailing stop follows the high after the trigger is reached.</p>
            <div className="autoGrid">
              <OptionalNumberField label="Move SL to break-even after %" value={config.breakevenTriggerPct} min={0} step={1} onChange={(v) => update("breakevenTriggerPct", v)} />
              <OptionalNumberField label="Start trailing after %" value={config.trailingTriggerPct} min={0} step={1} onChange={(v) => update("trailingTriggerPct", v)} />
              <OptionalNumberField label="Trailing distance %" value={config.trailingDistancePct} min={0} max={100} step={1} onChange={(v) => update("trailingDistancePct", v)} />
            </div>
          </div>

          <div className="autoWarning">
            <b>Live auto mode can spend real funds automatically.</b>
            <span>These holding rules are saved now; the auto-entry/exit engine must consume them before they can manage live autonomous positions.</span>
          </div>

          <div className="actions autoActions">
            <button disabled={busy} type="submit">Save settings</button>
            <button className="danger" disabled={busy || config.enabledLive || !readiness?.ready} type="button" onClick={() => void setLive(true)}>
              Enable autonomous live
            </button>
            <button className="secondary" disabled={busy || !config.enabledLive} type="button" onClick={() => void setLive(false)}>
              Disable live auto mode
            </button>
            <button className="secondary" disabled={busy} type="button" onClick={() => void load()}>
              Refresh
            </button>
          </div>
        </form>
      )}
    </main>
  );
}

function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return (
    <label>
      {label}
      <input type="number" value={value} min={min} max={max} step={step ?? 1} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function OptionalNumberField({ label, value, min, max, step, onChange }: { label: string; value: number | null; min?: number; max?: number; step?: number; onChange: (value: number | null) => void }) {
  return (
    <label>
      {label}
      <input placeholder="off" type="number" value={value ?? ""} min={min} max={max} step={step ?? 1} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
    </label>
  );
}

function HoldSelect({ label, value, allowOff, onChange }: { label: string; value: number | null; allowOff: boolean; onChange: (value: number | null) => void }) {
  return (
    <label>
      {label}
      <select value={value ?? "off"} onChange={(e) => onChange(e.target.value === "off" ? null : Number(e.target.value))}>
        {allowOff && <option value="off">Off</option>}
        {!allowOff && <option value={0}>No minimum</option>}
        <option value={60}>1 minute</option>
        <option value={300}>5 minutes</option>
        <option value={900}>15 minutes</option>
        <option value={1800}>30 minutes</option>
        <option value={3600}>1 hour</option>
        <option value={14400}>4 hours</option>
        <option value={86400}>1 day</option>
        <option value={259200}>3 days</option>
      </select>
    </label>
  );
}

function formatDuration(seconds: number | null) {
  if (seconds == null) return "off";
  if (seconds <= 0) return "no minimum";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function formatPercent(value: number | null) {
  return value == null ? "off" : `${value}%`;
}
