import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRiskEngine } from "./risk-engine.js";
import { scenarioA, scenarioB, scenarioC, scenarioD503 } from "./mock-payloads.js";
import { mapApiStateToUI } from "./ui-state.js";
import { calculateRSI, evaluateOscillatorState } from "./oscillator.js";
import { priceForShortPnl } from "./one-shot-test.js";

assert.equal(priceForShortPnl(100, 10, -25), 97.5);
assert.equal(priceForShortPnl(100, 10, 25), 102.5);

const rising = calculateRSI(Array.from({ length: 15 }, (_, index) => index + 1));
assert.equal(rising, 100);
assert.deepEqual(evaluateOscillatorState(29, "NONE"), { classification: "UP" });
assert.deepEqual(evaluateOscillatorState(71, "NONE"), { classification: "DOWN" });
assert.deepEqual(evaluateOscillatorState(60, "LONG"), { classification: "CLOSE" });
assert.deepEqual(evaluateOscillatorState(10, "LONG"), { classification: "CLOSE" });
assert.deepEqual(evaluateOscillatorState(40, "SHORT"), { classification: "CLOSE" });
assert.deepEqual(evaluateOscillatorState(90, "SHORT"), { classification: "CLOSE" });
assert.deepEqual(evaluateOscillatorState(30, "NONE"), { classification: "HOLD" });
assert.deepEqual(evaluateOscillatorState(70, "NONE"), { classification: "HOLD" });
assert.deepEqual(evaluateOscillatorState(50, "NONE"), { classification: "HOLD" });
assert.deepEqual(evaluateOscillatorState(59, "LONG"), { classification: "HOLD" });
assert.deepEqual(evaluateOscillatorState(41, "SHORT"), { classification: "HOLD" });

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
