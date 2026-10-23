import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRiskEngine } from "./risk-engine.js";
import { scenarioA, scenarioB, scenarioC, scenarioD503 } from "./mock-payloads.js";
import { mapApiStateToUI } from "./ui-state.js";
import { calculateEMA, evaluateEmaCrossover } from "./oscillator.js";
import { priceForShortPnl } from "./one-shot-test.js";
import { toHyperliquidCoin } from "./adapters/hyperliquid-market-data.js";
import { ENTRY_COOLDOWN_MS, entryCooldownRemaining } from "./pipeline.js";

assert.equal(entryCooldownRemaining(undefined), 0);
assert.equal(entryCooldownRemaining(Date.now() - ENTRY_COOLDOWN_MS + 1_000, Date.now()), 1_000);
assert.equal(entryCooldownRemaining(Date.now() - ENTRY_COOLDOWN_MS - 1, Date.now()), 0);


assert.equal(toHyperliquidCoin("XYZ100"), "xyz:XYZ100");
assert.equal(toHyperliquidCoin("XYZ100-USDC"), "xyz:XYZ100");
import { parseE8AccountMetadata, parseE8InstrumentMetadata, summarizeE8Metadata, validateE8InstrumentMetadata } from "./adapters/e8-client.js";

function unwrapList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["assets", "items", "results"]) {
    const list = (value as Record<string, unknown>)[key];
    if (Array.isArray(list)) return list;
  }
  return [];
}

assert.deepEqual(unwrapList({ assets: [{ symbol: "XAUUSD" }] }), [{ symbol: "XAUUSD" }]);
assert.deepEqual(unwrapList({ results: [] }), []);
assert.deepEqual(unwrapList({ error: "catalog unavailable" }), []);

assert.equal(priceForShortPnl(100, 10, -25), 97.5);
assert.equal(priceForShortPnl(100, 10, 25), 102.5);

const e8Account = parseE8AccountMetadata({ product: "Perpetual Futures", freeMargin: 5000 });
const e8Xau = parseE8InstrumentMetadata({ symbol: "XAUUSD", class: "cfd", minSize: 0.01, tickSize: 0.01 });
assert.equal(e8Account.product, "Perpetual Futures");
assert.equal(e8Xau.instrumentClass, "cfd");
assert.equal(e8Xau.quantityMode, "unknown");
assert.equal(summarizeE8Metadata(e8Account, e8Xau).status, "mismatch");
assert.equal(e8Xau.raw.class, "cfd");
assert.throws(() => validateE8InstrumentMetadata(e8Xau), /market is not confirmed open/);
assert.doesNotThrow(() => validateE8InstrumentMetadata({
  quantityMode: "size",
  minSize: 0.01,
  tickSize: 0.01,
  pricePrecision: 2,
  isMarketOpen: true,
  raw: {},
}));
assert.throws(() => validateE8InstrumentMetadata({
  quantityMode: "size",
  minSize: 0.01,
  tickSize: 0.01,
  pricePrecision: 2,
  isMarketOpen: false,
  raw: {},
}), /market is not confirmed open/);
assert.throws(() => validateE8InstrumentMetadata({
  quantityMode: "unknown",
  minSize: 0.01,
  tickSize: 0.01,
  pricePrecision: 2,
  isMarketOpen: true,
  raw: {},
}), /amount unit is missing or ambiguous/);

assert.equal(calculateEMA([1, 2, 3, 4, 5], 3), 4);
assert.equal(evaluateEmaCrossover(101, 100, "NONE"), "UP");
assert.equal(evaluateEmaCrossover(99, 100, "NONE"), "DOWN");
assert.equal(evaluateEmaCrossover(99, 100, "LONG"), "CLOSE");
assert.equal(evaluateEmaCrossover(101, 100, "LONG"), "HOLD");
assert.equal(evaluateEmaCrossover(101, 100, "SHORT"), "CLOSE");
assert.equal(evaluateEmaCrossover(99, 100, "SHORT"), "HOLD");
assert.equal(evaluateEmaCrossover(100, 100, "NONE"), "HOLD");

const happy = mapApiStateToUI(scenarioA);
assert.equal(happy.account.state, "Active");
assert.equal(happy.challenge.state, "Running");
assert.equal(happy.risk.state, "Safe");

assert.equal(mapApiStateToUI(scenarioB).risk.state, "Warning");
const violation = mapApiStateToUI(scenarioC);
assert.equal(violation.risk.state, "Violation");
assert.equal(violation.account.state, "Violated");
assert.equal(mapApiStateToUI(scenarioD503).dataStatus, "Unavailable");


const dir = await mkdtemp(join(tmpdir(), "propr-check-"));
const path = new URL(`file://${join(dir, "accounts.json")}`);
await writeFile(path, JSON.stringify({ initial_balance: 100, balance: 0, equity: 0, max_daily_loss: 100 }));
assert.equal(await checkRiskEngine(path), false);
console.log("self-check passed: threshold loss locks account");
