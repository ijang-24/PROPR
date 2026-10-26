"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Swal from "sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";

const toast = Swal.mixin({
  toast: true,
  position: "top-end",
  showConfirmButton: false,
  timer: 3_500,
  timerProgressBar: true,
  background: "#0f172a",
  color: "#e2e8f0",
});

const modalTheme = {
  background: "#0f172a",
  color: "#e2e8f0",
  confirmButtonColor: "#0891b2",
  cancelButtonColor: "#334155",
};

function reasonMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

type RiskState = "Safe" | "Warning" | "Violation";
type AccountType = "funded" | "challenge" | "unassigned";
type PlatformFilter = "all" | "propr" | "e8";
type TypeFilter = "all" | AccountType;
type Trade = { id: string; side: string; quantity: number; price: number; pnl: number; timestamp: string };
type MarketInsight = {
  label: string;
  symbol: string;
  source: "Hyperliquid" | "none";
  status: "ready" | "stale" | "unsupported" | "error";
  close?: number;
  previousClose?: number;
  changePct?: number;
  asOf?: number;
  reason?: string;
};

type Account = {
  accountId: string;
  platform: string;
  accountType: AccountType;
  accountProduct: string;
  instrumentClass: string;
  metadataStatus: string;
  currentEquity: number;
  initialBalance: number;
  targetProfit: number;
  dailyDd: number;
  maxDd: number;
  lastTradeBalance: number;
  progressToTarget: number;
  riskState: RiskState;
  currentPosition: string;
  tradeHistory: Trade[];
  updatedAt: string;
};

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function shortId(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function riskClasses(risk: RiskState): string {
  if (risk === "Violation") return "border-red-500/80 bg-red-950/90 shadow-[0_0_36px_rgba(239,68,68,0.2)]";
  if (risk === "Warning") return "border-amber-400/80 bg-amber-950/30";
  return "border-slate-800 bg-slate-900/80";
}

function riskTextClasses(risk: RiskState): string {
  if (risk === "Violation") return "text-red-300";
  if (risk === "Warning") return "text-amber-300";
  return "text-emerald-300";
}

function tradeDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function DashboardPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [marketInsights, setMarketInsights] = useState<MarketInsight[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [marketUpdatedAt, setMarketUpdatedAt] = useState<number | null>(null);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [settingType, setSettingType] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const errorToast = useRef<string | null>(null);

  const showError = useCallback((message: string) => {
    if (errorToast.current === message) return;
    errorToast.current = message;
    void toast.fire({ icon: "error", title: "Dashboard error", text: message });
  }, []);

  const clearError = useCallback(() => {
    errorToast.current = null;
  }, []);

  const removeAccount = useCallback(async (account: Account) => {
    const result = await Swal.fire({
      ...modalTheme,
      icon: "warning",
      title: "Remove local account?",
      text: `Only local registry/state for ${shortId(account.accountId)} will be removed. Remote positions and orders will not be touched.`,
      showCancelButton: true,
      confirmButtonText: "Remove locally",
      cancelButtonText: "Keep account",
      confirmButtonColor: "#dc2626",
      focusCancel: true,
    });
    if (!result.isConfirmed) return;

    setRemoving(account.accountId);
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(account.accountId)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Local account removal failed");
      setAccounts((current) => current.filter((item) => item.accountId !== account.accountId));
      await toast.fire({ icon: "success", title: "Account removed locally", text: `${shortId(account.accountId)} is no longer in the local registry.` });
    } catch (reason) {
      showError(reasonMessage(reason, "Local account removal failed"));
    } finally {
      setRemoving(null);
    }
  }, [showError]);

  const loadAccounts = useCallback(async () => {
    try {
      const response = await fetch("/api/accounts", { cache: "no-store" });
      if (!response.ok) throw new Error("Account state unavailable");
      const payload = await response.json() as { accounts?: Account[]; updatedAt?: string };
      setAccounts(payload.accounts ?? []);
      setUpdatedAt(payload.updatedAt ?? null);
      clearError();
    } catch (reason) {
      showError(reasonMessage(reason, "Account state unavailable"));
    }
  }, [clearError, showError]);

  const loadMarketInsights = useCallback(async () => {
    try {
      const response = await fetch("/api/market-insight", { cache: "no-store" });
      if (!response.ok) throw new Error("Market insight unavailable");
      const payload = await response.json() as { insights?: MarketInsight[]; updatedAt?: number };
      setMarketInsights(payload.insights ?? []);
      setMarketUpdatedAt(payload.updatedAt ?? null);
    } catch (reason) {
      showError(reasonMessage(reason, "Market insight unavailable"));
    }
  }, [showError]);

  function insightValue(insight: MarketInsight): string {
    if (insight.close === undefined) return insight.reason ?? "Unavailable";
    return `${insight.close.toLocaleString(undefined, { maximumFractionDigits: 4 })} · ${insight.changePct !== undefined ? `${insight.changePct >= 0 ? "+" : ""}${insight.changePct.toFixed(2)}%` : "—"}`;
  }

  function insightStatus(insight: MarketInsight): string {
    if (insight.status === "ready") return "Ready · 1m snapshot";
    if (insight.status === "stale") return "Stale · 1m snapshot";
    if (insight.status === "unsupported") return "No verified feed";
    return "Feed error";
  }

  const visibleAccounts = accounts.filter((account) =>
    (platformFilter === "all" || account.platform === platformFilter)
    && (typeFilter === "all" || account.accountType === typeFilter),
  );

  const setAccountType = useCallback(async (account: Account, accountType: Exclude<AccountType, "unassigned">) => {
    setSettingType(account.accountId);
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(account.accountId)}/type`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountType }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Account type update failed");
      setAccounts((current) => current.map((item) => item.accountId === account.accountId ? { ...item, accountType } : item));
      await toast.fire({ icon: "success", title: "Account type saved", text: `${shortId(account.accountId)} set as ${accountType}.` });
    } catch (reason) {
      showError(reasonMessage(reason, "Account type update failed"));
    } finally {
      setSettingType(null);
    }
  }, [showError]);

  const configureAccountType = useCallback(async (account: Account) => {
    const result = await Swal.fire({
      ...modalTheme,
      title: "Set account type",
      text: `Choose a category for ${shortId(account.accountId)}.`,
      input: "radio",
      inputOptions: { funded: "Funded", challenge: "Challenge" },
      inputValue: account.accountType === "unassigned" ? "" : account.accountType,
      showCancelButton: true,
      confirmButtonText: "Save type",
      cancelButtonText: "Cancel",
      inputValidator: (value) => value ? undefined : "Select funded or challenge",
    });
    if (result.isConfirmed && (result.value === "funded" || result.value === "challenge")) {
      await setAccountType(account, result.value);
    }
  }, [setAccountType]);

  const filterButton = (active: boolean): string => active
    ? "rounded-lg bg-cyan-400 px-3 py-2 text-xs font-bold text-slate-950"
    : "rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-400 hover:border-cyan-400/60 hover:text-cyan-300";

  const filterLabel = (value: string): string => value === "all" ? "All" : value[0]!.toUpperCase() + value.slice(1);

  const unlock = useCallback(async (account: Account) => {
    const result = await Swal.fire({
      ...modalTheme,
      icon: "warning",
      title: "Unlock trading?",
      text: `Review account ${shortId(account.accountId)} before resuming the pipeline.`,
      showCancelButton: true,
      confirmButtonText: "Unlock account",
      cancelButtonText: "Keep locked",
      focusCancel: true,
    });
    if (!result.isConfirmed) return;

    setUnlocking(account.accountId);
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(account.accountId)}/unlock`, { method: "POST" });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unlock failed");
      await loadAccounts();
      await toast.fire({ icon: "success", title: "Trading unlocked", text: `${shortId(account.accountId)} can trade again.` });
    } catch (reason) {
      showError(reasonMessage(reason, "Unlock failed"));
    } finally {
      setUnlocking(null);
    }
  }, [loadAccounts, showError]);

  useEffect(() => {
    void loadAccounts();
    void loadMarketInsights();
    const timer = window.setInterval(() => void loadAccounts(), 3_000);
    const marketTimer = window.setInterval(() => void loadMarketInsights(), 30_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(marketTimer);
    };
  }, [loadAccounts, loadMarketInsights]);

  useEffect(() => {
    return () => Swal.close();
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100 sm:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 flex flex-col justify-between gap-4 border-b border-slate-800 pb-6 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.3em] text-cyan-400">Layer C / Monitor</p>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Account Dashboard</h1>
            <p className="mt-2 text-sm text-slate-400">Local account state · market snapshots refresh every 30 seconds</p>
          </div>
          <p className="text-xs text-slate-500">{updatedAt ? `Last sync ${new Date(updatedAt).toLocaleTimeString()}` : "Waiting for state"}</p>
        </header>

        <section aria-labelledby="market-insight-title" className="mb-10 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
          <h2 id="market-insight-title" className="sr-only">Market insight snapshots</h2>
          <div className="flex min-w-max gap-3">
            {marketInsights.map((insight) => {
              const positive = (insight.changePct ?? 0) >= 0;
              const tone = insight.status === "ready" ? (positive ? "border-emerald-400/30" : "border-red-400/30") : "border-slate-700";
              return <div key={insight.label} className={`min-w-44 rounded-xl border ${tone} bg-slate-950/70 px-4 py-3`}>
                <div className="flex items-center justify-between gap-3"><span className="text-xs font-bold tracking-wider text-slate-200">{insight.label}</span><span className="text-xs uppercase tracking-wider text-slate-400">{insight.source}</span></div>
                <p className={`mt-2 text-sm font-semibold ${insight.status === "ready" ? (positive ? "text-emerald-300" : "text-red-300") : "text-slate-400"}`}>{insightValue(insight)}</p>
                <p className="mt-1 text-xs uppercase tracking-wide text-slate-300">{insightStatus(insight)}</p>
                {insight.asOf && <p className="mt-1 text-xs text-slate-400">{new Date(insight.asOf).toLocaleTimeString()}</p>}
              </div>;
            })}
          </div>
          <p className="mt-3 text-xs text-slate-400">{marketUpdatedAt ? `Market response ${new Date(marketUpdatedAt).toLocaleTimeString()}` : "Market feed pending"}. Values are candle closes, not live ticks.</p>
        </section>

        {accounts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 px-6 py-16 text-center text-sm text-slate-500">No account state files found.</div>
        ) : (
          <>
            <section className="mb-8 space-y-3">
              <div className="flex flex-wrap gap-2">
                {(["all", "propr", "e8"] as const).map((value) => <button key={value} type="button" className={filterButton(platformFilter === value)} onClick={() => setPlatformFilter(value)}>{filterLabel(value)}</button>)}
              </div>
              <div className="flex flex-wrap gap-2">
                {(["all", "funded", "challenge", "unassigned"] as const).map((value) => <button key={value} type="button" className={filterButton(typeFilter === value)} onClick={() => setTypeFilter(value)}>{filterLabel(value)}</button>)}
              </div>
            </section>
            {visibleAccounts.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-800 px-6 py-16 text-center text-sm text-slate-500">No accounts match these filters.</div> : <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {visibleAccounts.map((account) => {
              const violation = account.riskState === "Violation";
              const progress = Math.max(0, Math.min(100, account.progressToTarget));
              return (
                <article key={account.accountId} className={`overflow-hidden rounded-2xl border p-6 transition ${riskClasses(account.riskState)}`}>
                  {violation && <div className="-mx-6 -mt-6 mb-6 bg-red-600 px-6 py-2 text-center text-xs font-black tracking-[0.2em] text-white">EMERGENCY STOP TRIGGERED</div>}
                  <div className="flex items-start justify-between gap-4">
                    <div><p className="text-xs uppercase tracking-widest text-slate-500">Account ID</p><p className="mt-2 font-mono text-sm text-slate-200" title={account.accountId}>{shortId(account.accountId)}</p><div className="mt-1 flex items-center gap-2 text-xs uppercase tracking-widest text-cyan-400"><span>{account.platform}</span><span className="text-slate-600">·</span><span className="text-violet-300">{account.accountType}</span></div></div>
                    <span className={`rounded-full border border-current/20 px-3 py-1 text-xs font-semibold ${riskTextClasses(account.riskState)}`}>{account.riskState}</span>
                  </div>

                  <div className="mt-8"><p className="text-xs uppercase tracking-widest text-slate-500">Current Equity</p><p className="mt-1 text-4xl font-semibold tracking-tight text-white">{money(account.currentEquity)}</p></div>

                  <div className="mt-6">
                    <div className="mb-2 flex justify-between text-xs"><span className="text-slate-400">Progress to Target</span><span className="font-semibold text-cyan-300">{account.progressToTarget.toFixed(1)}%</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all" style={{ width: `${progress}%` }} /></div>
                  </div>

                  <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-white/10 pt-5">
                    <div><dt className="text-xs text-slate-500">Initial Balance</dt><dd className="mt-1 text-sm font-medium text-slate-200">{money(account.initialBalance)}</dd></div>
                    <div><dt className="text-xs text-slate-500">Target Profit</dt><dd className="mt-1 text-sm font-medium text-emerald-300">{money(account.targetProfit)}</dd></div>
                    <div><dt className="text-xs text-slate-500">Daily Drawdown</dt><dd className="mt-1 text-sm font-medium text-amber-300">{money(account.dailyDd)}</dd></div>
                    <div><dt className="text-xs text-slate-500">Max Drawdown</dt><dd className="mt-1 text-sm font-medium text-red-300">{money(account.maxDd)}</dd></div>
                    <div><dt className="text-xs text-slate-500">Last Trade Balance</dt><dd className="mt-1 text-sm font-medium text-slate-200">{money(account.lastTradeBalance)}</dd></div>
                    <div><dt className="text-xs text-slate-500">Current Position</dt><dd className="mt-1 text-sm font-semibold text-cyan-300">{account.currentPosition}</dd></div>
                    <div><dt className="text-xs text-slate-500">Account Product</dt><dd className="mt-1 text-sm font-medium text-slate-200">{account.accountProduct}</dd></div>
                    <div><dt className="text-xs text-slate-500">Instrument Class</dt><dd className="mt-1 text-sm font-medium text-slate-200">{account.instrumentClass}</dd></div>
                    <div><dt className="text-xs text-slate-500">Metadata Status</dt><dd className={`mt-1 text-sm font-medium ${account.metadataStatus === "mismatch" ? "text-amber-300" : "text-slate-200"}`}>{account.metadataStatus}</dd></div>
                  </dl>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void configureAccountType(account)} disabled={settingType === account.accountId || removing === account.accountId} className="rounded-lg border border-violet-300/30 px-3 py-2 text-xs font-semibold text-violet-200 transition hover:bg-violet-500/15 disabled:cursor-wait disabled:opacity-50">
                      {settingType === account.accountId ? "Saving…" : `Set as ${account.accountType === "unassigned" ? "funded / challenge" : account.accountType}`}
                    </button>
                    <button type="button" onClick={() => void removeAccount(account)} disabled={removing === account.accountId || settingType === account.accountId || unlocking === account.accountId} className="rounded-lg border border-red-300/30 px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-500/15 disabled:cursor-wait disabled:opacity-50">
                      {removing === account.accountId ? "Removing…" : "Remove locally"}
                    </button>
                  </div>

                  {violation && (
                    <div className="mt-6 border-t border-red-400/20 pt-5">
                      <p className="text-xs leading-5 text-red-200">Trading stopped after the drawdown limit was reached. Review the account before unlocking.</p>
                      <button type="button" onClick={() => void unlock(account)} disabled={unlocking === account.accountId} className="mt-3 rounded-lg border border-red-300/40 px-3 py-2 text-xs font-semibold text-red-100 transition hover:bg-red-500/20 disabled:cursor-wait disabled:opacity-50">
                        {unlocking === account.accountId ? "Unlocking…" : "Unlock after review"}
                      </button>
                    </div>
                  )}

                  <div className="mt-6 border-t border-white/10 pt-5">
                    <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Recent Trades</h2><span className="text-xs text-slate-600">{account.tradeHistory.length}</span></div>
                    {account.tradeHistory.length === 0 ? <p className="text-sm text-slate-600">No trades yet</p> : <div className="max-h-40 space-y-2 overflow-y-auto pr-1">{account.tradeHistory.map((trade) => <div key={trade.id} className="rounded-lg bg-black/20 px-3 py-2 text-xs"><div className="flex justify-between gap-3"><span className={trade.side.includes("SELL") || trade.side.includes("SHORT") ? "text-red-300" : "text-emerald-300"}>{trade.side}</span><span className={trade.pnl >= 0 ? "text-emerald-300" : "text-red-300"}>{money(trade.pnl)}</span></div><div className="mt-1 flex justify-between text-slate-500"><span>Qty {trade.quantity} · {money(trade.price)}</span><span>{tradeDate(trade.timestamp)}</span></div></div>)}</div>}
                  </div>
                </article>
              );
            })}
          </section>}
          </>
        )}
      </div>
    </main>
  );
}
