import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

const ACCOUNTS_DIR = join(process.cwd(), "src", ".accounts");

type RawTrade = {
  id?: unknown;
  tradeId?: unknown;
  side?: unknown;
  type?: unknown;
  quantity?: unknown;
  price?: unknown;
  pnl?: unknown;
  realizedPnl?: unknown;
  timestamp?: unknown;
  executedAt?: unknown;
};

type RawAccount = {
  accountId?: unknown;
  platform?: unknown;
  accountType?: unknown;
  accountProduct?: unknown;
  instrumentClass?: unknown;
  metadataStatus?: unknown;
  initial_balance?: unknown;
  initialBalance?: unknown;
  balance?: unknown;
  equity?: unknown;
  locked?: unknown;
  status?: unknown;
  riskState?: unknown;
  risk?: { state?: unknown };
  currentPosition?: unknown;
  position?: unknown;
  positionSide?: unknown;
  targetProfit?: unknown;
  dailyDd?: unknown;
  maxDd?: unknown;
  lastTradeBalance?: unknown;
  tradeHistory?: unknown;
  updated_at?: unknown;
  updatedAt?: unknown;
};

function numberValue(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function riskState(account: RawAccount, equity: number): "Safe" | "Warning" | "Violation" {
  const explicit = account.riskState ?? account.risk?.state;
  if (explicit === "Violation" || explicit === "Warning" || explicit === "Safe") return explicit;
  if (account.locked === true || account.status === "Violated") return "Violation";
  const initial = numberValue(account.initial_balance ?? account.initialBalance, 5_000);
  if (equity <= initial - 100) return "Violation";
  if (equity <= initial - 50) return "Warning";
  return "Safe";
}

function tradeHistory(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).reverse().map((trade, index) => {
    const item = trade && typeof trade === "object" ? trade as RawTrade : {};
    return {
      id: stringValue(item.id ?? item.tradeId, `trade-${index}`),
      side: stringValue(item.side ?? item.type, "UNKNOWN").toUpperCase(),
      quantity: numberValue(item.quantity),
      price: numberValue(item.price),
      pnl: numberValue(item.pnl ?? item.realizedPnl),
      timestamp: stringValue(item.timestamp ?? item.executedAt, ""),
    };
  });
}

async function readAccount(fileName: string) {
  const raw = JSON.parse(await readFile(join(ACCOUNTS_DIR, fileName), "utf8")) as RawAccount;
  const initialBalance = numberValue(raw.initial_balance ?? raw.initialBalance, 5_000);
  const currentEquity = numberValue(raw.equity, numberValue(raw.balance, initialBalance));
  const position = raw.currentPosition ?? raw.positionSide ?? raw.position;

  return {
    accountId: stringValue(raw.accountId, fileName.replace(/\.json$/i, "")),
    platform: stringValue(raw.platform, "unknown"),
    accountType: raw.accountType === "funded" || raw.accountType === "challenge" ? raw.accountType : "unassigned",
    accountProduct: stringValue(raw.accountProduct, "unknown"),
    instrumentClass: stringValue(raw.instrumentClass, "unknown"),
    metadataStatus: stringValue(raw.metadataStatus, "unknown"),
    currentEquity,
    initialBalance,
    targetProfit: numberValue(raw.targetProfit),
    dailyDd: numberValue(raw.dailyDd),
    maxDd: numberValue(raw.maxDd),
    lastTradeBalance: numberValue(raw.lastTradeBalance, numberValue(raw.balance, currentEquity)),
    progressToTarget: numberValue(raw.targetProfit) > 0
      ? ((currentEquity - initialBalance) / numberValue(raw.targetProfit)) * 100
      : 0,
    riskState: riskState(raw, currentEquity),
    currentPosition: typeof position === "string" ? position.toUpperCase() : "NONE",
    tradeHistory: tradeHistory(raw.tradeHistory),
    updatedAt: stringValue(raw.updated_at ?? raw.updatedAt, new Date().toISOString()),
  };
}

export async function GET() {
  try {
    const files = (await readdir(ACCOUNTS_DIR)).filter((file) => file.endsWith(".json"));
    const accounts = await Promise.all(files.map((file) => readAccount(file)));
    return Response.json({ accounts, updatedAt: new Date().toISOString() });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return Response.json({ accounts: [], updatedAt: new Date().toISOString() });
    console.error("Failed to read account state", error);
    return Response.json({ error: "Unable to read account state" }, { status: 500 });
  }
}
