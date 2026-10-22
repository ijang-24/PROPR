import type { Candle } from "../types.js";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const DEFAULT_TIMEOUT_MS = 10_000;
const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
};

interface HyperliquidCandle {
  t?: unknown;
  o?: unknown;
  h?: unknown;
  l?: unknown;
  c?: unknown;
  v?: unknown;
}

export function toHyperliquidCoin(symbol: string): string {
  const value = symbol.trim();
  if (!value || value.includes("/")) throw new Error(`Invalid market symbol: ${symbol}`);
  if (value.toUpperCase() === "XYZ100-USDC") return "xyz:XYZ100";

  const [base, quote] = value.split("-");
  if (!base) throw new Error(`Invalid market symbol: ${symbol}`);
  if (quote && quote.toUpperCase() !== "USDC") throw new Error(`Unsupported market quote: ${quote}`);
  return base.includes(":") ? base : base.toUpperCase();
}

function parseCandle(value: HyperliquidCandle): Candle | null {
  const timestamp = Number(value.t);
  const open = Number(value.o);
  const high = Number(value.h);
  const low = Number(value.l);
  const close = Number(value.c);
  const volume = value.v === undefined ? undefined : Number(value.v);
  const values = [timestamp, open, high, low, close, ...(volume === undefined ? [] : [volume])];
  if (!values.every(Number.isFinite)) return null;
  return { timestamp, open, high, low, close, ...(volume === undefined ? {} : { volume }) };
}

export async function fetchHyperliquidCandles(
  symbol: string,
  interval: string,
  limit: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Candle[]> {
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) throw new Error(`Hyperliquid candle interval unsupported: ${interval}; use 1m or higher`);
  if (!Number.isInteger(limit) || limit < 15) throw new Error("At least 15 candles are required for RSI");

  const endTime = Date.now();
  const response = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: {
        coin: toHyperliquidCoin(symbol),
        interval,
        startTime: endTime - (intervalMs * limit),
        endTime,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Hyperliquid market data ${response.status}`);

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error("Hyperliquid candle response is not an array");
  const candles = payload
    .map((value) => value && typeof value === "object" ? parseCandle(value as HyperliquidCandle) : null)
    .filter((candle): candle is Candle => candle !== null)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (candles.length < 15) throw new Error(`Hyperliquid returned only ${candles.length} candles`);
  return candles.slice(-limit);
}
