import type { Classification } from "./types.js";

export interface OscillatorDecision {
  classification: Classification;
}

/** Returns the latest Wilder-smoothed RSI for the supplied closing prices. */
export function calculateRSI(closes: number[], period = 14): number {
  if (!Number.isInteger(period) || period <= 0) throw new Error("RSI period must be a positive integer");
  if (closes.length < period + 1) throw new Error(`RSI requires at least ${period + 1} closes`);
  if (!closes.every(Number.isFinite)) throw new Error("RSI closes must be finite numbers");

  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    averageGain = ((averageGain * (period - 1)) + gain) / period;
    averageLoss = ((averageLoss * (period - 1)) + loss) / period;
  }

  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - (100 / (1 + (averageGain / averageLoss)));
}

export function evaluateOscillatorState(currentRsi: number): OscillatorDecision {
  if (!Number.isFinite(currentRsi)) throw new Error("RSI must be a finite number");
  if (currentRsi >= 80) return { classification: "DOWN" };
  if (currentRsi <= 15) return { classification: "UP" };
  return { classification: "HOLD" };
}
