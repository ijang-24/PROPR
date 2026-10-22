import { access, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAccountSnapshot } from "./accounts.js";
import { config } from "./config.js";
import { OfficialProprClient } from "./adapters/propr-client.js";
import { checkRiskEngine } from "./risk-engine.js";
import { calculateRSI, evaluateOscillatorState } from "./oscillator.js";
import type { Candle, Position, ProprClient, Side } from "./types.js";

/** Defaults to safe dry-run mode unless `.env` sets DRY_RUN=false. */
export const DRY_RUN = config.dryRun;
const CANDLE_LIMIT = 100;
const runningAccounts = new Set<string>();
let isExecuting = false;

function closesFrom(candles: Candle[]): number[] {
  const closes = new Array<number>(candles.length);
  for (let index = 0; index < candles.length; index += 1) closes[index] = candles[index]!.close;
  return closes;
}

function roundQuantity(value: number): number {
  return Number(value.toPrecision(8));
}

function protectedPrices(side: Side, entryPrice: number, quantity: number): { takeProfitPrice: number; stopLossPrice: number } {
  const targetDistance = config.targetPnl / quantity;
  const takeProfitPrice = side === "long" ? entryPrice + targetDistance : entryPrice - targetDistance;
  const stopLossPrice = side === "long" ? entryPrice - targetDistance : entryPrice + targetDistance;
  if (takeProfitPrice <= 0 || stopLossPrice <= 0) throw new Error("Calculated TP/SL price is invalid");
  return { takeProfitPrice, stopLossPrice };
}

function entryQuantity(equity: number, entryPrice: number): number {
  if (!Number.isFinite(equity) || equity <= 0) throw new Error("Account equity must be positive");
  if (!Number.isFinite(config.marginFraction) || config.marginFraction <= 0 || config.marginFraction > 1) {
    throw new Error("MARGIN_FRACTION must be between 0 and 1");
  }
  return roundQuantity((equity * config.marginFraction * config.leverage) / entryPrice);
}

function accountStatePath(accountId: string): URL {
  const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return new URL(`./.accounts/${safeId}.json`, import.meta.url);
}

async function ensureAccountState(accountId: string): Promise<URL> {
  const path = accountStatePath(accountId);
  try {
    await access(path);
  } catch {
    await mkdir(new URL("./.accounts/", import.meta.url), { recursive: true });
    await copyFile(config.accountsPath, path);
  }
  return path;
}

async function enforceRiskLock(accountId: string, accountsPath: URL): Promise<void> {
  if (await checkRiskEngine(accountsPath)) return;
  console.error(`[RISK LOCK] Account ${accountId} violated. Terminating process.`);
  process.exit(1);
}

async function runAccount(client: ProprClient, accountId: string): Promise<void> {
  if (runningAccounts.has(accountId)) return;
  runningAccounts.add(accountId);
  try {
    await client.setup(accountId);
    const accountsPath = await ensureAccountState(accountId);
    const accountSnapshot = await client.refreshAccountSnapshot();
    await writeAccountSnapshot(accountsPath, accountSnapshot);
    await enforceRiskLock(accountId, accountsPath);

    const actualPositions = await client.getPositions(config.symbol);
    const actualPosition = actualPositions[0];
    const previousPosition: Position = actualPosition?.positionSide === "long"
      ? "LONG"
      : actualPosition?.positionSide === "short"
        ? "SHORT"
        : "NONE";
    const marketPrice = actualPosition?.markPrice;
    const candles = await client.fetchCandles(config.symbol, config.candleInterval, CANDLE_LIMIT);
    if (candles.length < 15) throw new Error("At least 15 candles are required for RSI");
    const entryPrice = candles.at(-1)?.close;
    if (!entryPrice || !Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error("No valid market price available");

    const rsi = calculateRSI(closesFrom(candles));
    const classification = evaluateOscillatorState(rsi, previousPosition).classification;
    const side: Side | null = classification === "UP"
      ? "long"
      : classification === "DOWN"
        ? "short"
        : classification === "CLOSE" && previousPosition === "LONG"
          ? "long"
          : classification === "CLOSE" && previousPosition === "SHORT"
            ? "short"
            : null;

    if (!side) {
      console.log(`[${DRY_RUN ? "DRY RUN" : "LIVE"}] Account: ${accountId} | RSI: ${rsi.toFixed(2)} | Propr Pos: ${previousPosition} | Signal: ${classification} | Action: HOLD`);
      return;
    }

    if (DRY_RUN) {
      const action = classification === "CLOSE" ? "WOULD_CLOSE" : side === "long" ? "WOULD_BUY" : "WOULD_SELL";
      console.log(`[DRY RUN] Account: ${accountId} | RSI: ${rsi.toFixed(2)} | Propr Pos: ${previousPosition} | Signal: ${classification} | Action: ${action}${marketPrice ? ` | Mark: ${marketPrice}` : ""}`);
      return;
    }

    if (await client.hasPendingOrders(config.symbol)) {
      console.log(`[LIVE] Account: ${accountId} | Propr Pos: ${previousPosition} | Signal: ${classification} | Action: WAIT_PENDING_ORDER`);
      return;
    }

    await enforceRiskLock(accountId, accountsPath);
    if (classification === "CLOSE") {
      if (!actualPosition) throw new Error("Close signal has no active position");
      const snapshot = await client.submit_trade({
        side,
        positionSide: previousPosition.toLowerCase() as Side,
        symbol: config.symbol,
        size: Number(actualPosition.quantity),
        closePosition: true,
      });
      await writeAccountSnapshot(accountsPath, snapshot);
      const verified = await client.getPositions(config.symbol);
      const verifiedPosition = verified[0]?.positionSide?.toUpperCase() ?? "NONE";
      console.log(`[LIVE] Account: ${accountId} | RSI: ${rsi.toFixed(2)} | Propr Pos: ${previousPosition} | Signal: ${classification} | Closed | Verified Pos: ${verifiedPosition}`);
      return;
    }

    await client.setLeverage(config.symbol, config.leverage);
    const quantity = entryQuantity(accountSnapshot.equity, entryPrice);
    if (quantity <= 0) throw new Error("Calculated entry quantity is not positive");
    const { takeProfitPrice, stopLossPrice } = protectedPrices(side, entryPrice, quantity);
    const orders = await client.submitProtectedTrade({
      side,
      symbol: config.symbol,
      quantity,
      entryPrice,
      takeProfitPrice,
      stopLossPrice,
    });
    const verified = await client.getPositions(config.symbol);
    const verifiedPosition = verified[0]?.positionSide?.toUpperCase() ?? "NONE";
    console.log(`[LIVE] Account: ${accountId} | RSI: ${rsi.toFixed(2)} | Propr Pos: ${previousPosition} | Signal: ${classification} | Qty: ${quantity} | TP: ${takeProfitPrice} | SL: ${stopLossPrice} | Orders: ${orders.length} | Verified Pos: ${verifiedPosition}`);
  } catch (error) {
    console.error(`Pipeline cycle failed for account ${accountId}; no retry/order fallback was attempted`, error);
  } finally {
    runningAccounts.delete(accountId);
  }
}

type ClientFactory = () => ProprClient;

async function runAllAccounts(createClient: ClientFactory): Promise<void> {
  if (isExecuting) return;
  isExecuting = true;
  try {
    for (const accountId of config.accountIds) await runAccount(createClient(), accountId);
  } finally {
    isExecuting = false;
  }
}

function startLoop(createClient: ClientFactory): NodeJS.Timeout {
  void runAllAccounts(createClient);
  const timer = setInterval(() => { void runAllAccounts(createClient); }, config.loopMs);
  const stop = (): void => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return timer;
}

export async function startPipeline(): Promise<void> {
  const createClient: ClientFactory = () => new OfficialProprClient(
    DRY_RUN,
    process.env.PROPR_API_KEY,
    config.apiUrl,
  );
  const client = createClient();
  const health = await client.health();
  if (health.status !== "OK") throw new Error(`Propr health check failed: ${health.status}`);
  if (config.accountIds.length === 0) throw new Error("PROPR_ACCOUNT_ID or PROPR_ACCOUNT_IDS is required");
  console.log("[SYSTEM] Starting Propr Pipeline...");
  console.warn(`Starting pipeline: accounts=${config.accountIds.join(",")}, symbol=${config.symbol}, interval=${config.candleInterval}, dryRun=${DRY_RUN}`);
  startLoop(createClient);
}

const launchedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (launchedDirectly) {
  void startPipeline().catch((error: unknown) => {
    console.error("Pipeline initialization failed", error);
    process.exitCode = 1;
  });
}

