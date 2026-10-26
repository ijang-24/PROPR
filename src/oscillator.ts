import type { Candle, Classification, Position } from "./types.js";

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

export type SupportResistanceLevels = {
  support: number;
  resistance: number;
  atr: number;
  tolerance: number;
  signalClose: number;
};

function trueRange(current: Candle, previous: Candle): number {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

/** Calculates levels from the completed candles supplied by the caller. */
export function calculateSupportResistance(
  candles: Candle[],
  lookback = 20,
  atrPeriod = 14,
): SupportResistanceLevels {
  if (!Number.isInteger(lookback) || lookback < 2) throw new Error("Support/resistance lookback must be at least 2");
  if (!Number.isInteger(atrPeriod) || atrPeriod < 1) throw new Error("ATR period must be positive");
  const signalIndex = candles.length - 1;
  if (signalIndex < Math.max(lookback, atrPeriod) + 1) {
    throw new Error("Support/resistance requires more completed candles");
  }
  const levelCandles = candles.slice(signalIndex - lookback, signalIndex);
  const atrStart = signalIndex - atrPeriod + 1;
  const ranges = Array.from({ length: atrPeriod }, (_, offset) => {
    const index = atrStart + offset;
    return trueRange(candles[index]!, candles[index - 1]!);
  });
  const support = Math.min(...levelCandles.map((candle) => candle.low));
  const resistance = Math.max(...levelCandles.map((candle) => candle.high));
  const atr = ranges.reduce((sum, range) => sum + range, 0) / ranges.length;
  const tolerance = atr * 0.5;
  const signalClose = candles[signalIndex]!.close;
  const values = [support, resistance, atr, tolerance, signalClose];
  if (!values.every(Number.isFinite) || support <= 0 || resistance <= support || atr <= 0) {
    throw new Error("Support/resistance levels are invalid");
  }
  return { support, resistance, atr, tolerance, signalClose };
}

/** EMA direction and S/R location are the two required entry confirmations. */
export function strategyTargetPosition(
  ema9: number,
  ema21: number,
  currentPosition: Position,
  candles: Candle[],
): Position {
  if (!Number.isFinite(ema9) || !Number.isFinite(ema21)) throw new Error("EMA values must be finite numbers");
  if (currentPosition !== "NONE") {
    if (currentPosition === "LONG" && ema9 < ema21) return "SHORT";
    if (currentPosition === "SHORT" && ema9 > ema21) return "LONG";
    return currentPosition;
  }
  if (ema9 === ema21) return "NONE";
  const levels = calculateSupportResistance(candles);
  if (levels.support + levels.tolerance >= levels.resistance - levels.tolerance) return "NONE";
  const atSupport = levels.signalClose >= levels.support && levels.signalClose <= levels.support + levels.tolerance;
  const atResistance = levels.signalClose <= levels.resistance && levels.signalClose >= levels.resistance - levels.tolerance;
  if (ema9 > ema21 && atSupport) return "LONG";
  if (ema9 < ema21 && atResistance) return "SHORT";
  return "NONE";
}
