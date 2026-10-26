import { fetchHyperliquidCandles } from "../../../src/adapters/hyperliquid-market-data.ts";

export const dynamic = "force-dynamic";

const CACHE_MS = 30_000;
const CANDLE_LIMIT = 22;
const MARKET_SYMBOLS = [
  { label: "XYZ100", symbol: "xyz:XYZ100" },
  { label: "GOLD", symbol: "xyz:GOLD" },
  { label: "USDC", symbol: "" },
  { label: "USDJPY", symbol: "" },
] as const;

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

let cached: { expiresAt: number; fetchedAt: number; data: MarketInsight[] } | undefined;

function refreshStatus(insight: MarketInsight, now: number): MarketInsight {
  if (insight.status === "ready" || insight.status === "stale") {
    const status = insight.asOf !== undefined && now - insight.asOf > 120_000 ? "stale" : "ready";
    return { ...insight, status, ...(status === "stale" ? { reason: "Latest candle is older than two minutes" } : { reason: undefined }) };
  }
  return insight;
}

async function readInsight(item: (typeof MARKET_SYMBOLS)[number]): Promise<MarketInsight> {
  if (!item.symbol) {
    return {
      label: item.label,
      symbol: item.label,
      source: "none",
      status: "unsupported",
      reason: "No verified candle feed is configured for this symbol",
    };
  }
  try {
    const candles = await fetchHyperliquidCandles(item.symbol, "1m", CANDLE_LIMIT);
    const latest = candles.at(-1);
    const previous = candles.at(-2);
    if (!latest || !previous || previous.close === 0) {
      return { label: item.label, symbol: item.symbol, source: "Hyperliquid", status: "error", reason: "Candle feed returned insufficient data" };
    }
    const asOf = latest.timestamp;
    const status = Date.now() - asOf > 120_000 ? "stale" : "ready";
    return {
      label: item.label,
      symbol: item.symbol,
      source: "Hyperliquid",
      status,
      close: latest.close,
      previousClose: previous.close,
      changePct: ((latest.close - previous.close) / previous.close) * 100,
      asOf,
      ...(status === "stale" ? { reason: "Latest candle is older than two minutes" } : {}),
    };
  } catch (error) {
    return {
      label: item.label,
      symbol: item.symbol,
      source: "Hyperliquid",
      status: "error",
      reason: error instanceof Error ? error.message : "Market data request failed",
    };
  }
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return Response.json({ insights: cached.data.map((insight) => refreshStatus(insight, now)), updatedAt: cached.fetchedAt });
  }
  const data = await Promise.all(MARKET_SYMBOLS.map(readInsight));
  cached = { expiresAt: now + CACHE_MS, fetchedAt: now, data };
  return Response.json({ insights: data, updatedAt: now });
}
