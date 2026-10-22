import { config } from "./config.js";
import { writeAccountSnapshot } from "./accounts.js";
import { checkRiskEngine } from "./risk-engine.js";
import { calculateRSI, evaluateOscillatorState } from "./oscillator.js";
import type { ProprClient, Side } from "./types.js";

let running = false;

export async function runOnce(client: ProprClient): Promise<void> {
  if (running) return;
  running = true;
  try {
    const accountSnapshot = await client.refreshAccountSnapshot();
    await writeAccountSnapshot(config.accountsPath, accountSnapshot);
    if (!(await checkRiskEngine(config.accountsPath))) return;
    const candles = await client.fetchCandles(config.symbol, config.candleInterval, 100);
    if (candles.length === 0) throw new Error("No candles returned");
    const classification = evaluateOscillatorState(calculateRSI(candles.map((candle) => candle.close))).classification;
    if (classification === "HOLD") return;
    if (!(await checkRiskEngine(config.accountsPath))) return;
    const side: Side = classification === "UP" ? "long" : "short";
    const snapshot = await client.submit_trade({ side, symbol: config.symbol, size: config.orderSize });
    await writeAccountSnapshot(config.accountsPath, snapshot);
    console.log(`Trade completed: ${side}, equity=${snapshot.equity}`);
  } catch (error) {
    console.error("Pipeline cycle failed; no retry/order fallback was attempted", error);
  } finally {
    running = false;
  }
}
