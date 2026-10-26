import type { Classification, Position } from "./types.js";

/** Returns the latest standard EMA seeded with the first-period SMA. */
export function calculateEMA(prices: number[], period: number): number {
  if (!Number.isInteger(period) || period <= 0) throw new Error("EMA period must be a positive integer");
  if (prices.length < period) throw new Error(`EMA requires at least ${period} prices`);
  if (!prices.every(Number.isFinite)) throw new Error("EMA prices must be finite numbers");

  let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < prices.length; index += 1) {
    ema = ((prices[index]! - ema) * multiplier) + ema;
  }
  return ema;
}

export function evaluateEmaCrossover(
  ema9: number,
  ema21: number,
  currentPosition: Position,
): Classification {
  if (!Number.isFinite(ema9) || !Number.isFinite(ema21)) {
    throw new Error("EMA values must be finite numbers");
  }
  if (ema9 === ema21) return "HOLD";
  if (currentPosition === "NONE") return ema9 > ema21 ? "UP" : "DOWN";
  if (currentPosition === "LONG") return ema9 < ema21 ? "CLOSE" : "HOLD";
  return ema9 > ema21 ? "CLOSE" : "HOLD";
}

