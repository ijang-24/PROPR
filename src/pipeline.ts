import { access, copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccounts, updateAccountState, writeAccountSnapshot } from "./accounts.js";
import { loadTradingAccounts } from "./account-registry.js";
import { config } from "./config.js";
import { fetchHyperliquidCandles } from "./adapters/hyperliquid-market-data.js";
import { createPlatformClient } from "./adapters/platform-client.js";
import { checkRiskEngine } from "./risk-engine.js";
import { calculateEMA, evaluateEmaCrossover } from "./oscillator.js";
import {
  cooldownRemaining,
  cooldownUntilRemaining,
  planPositionTransition,
  positionToSide,
  PROPR_COOLDOWN_MS,
} from "./types.js";
import type {
  AccountSnapshot,
  Candle,
  Platform,
  Position,
  ProprClient,
  ProprPosition,
  Side,
  TradingAccount,
} from "./types.js";

/** Defaults to safe dry-run mode unless `.env` sets DRY_RUN=false. */
export const DRY_RUN = config.dryRun;
export const ENTRY_COOLDOWN_MS = 2 * 60_000;
export const MASTER_CLOSE_COOLDOWN_MS = PROPR_COOLDOWN_MS;
const CANDLE_LIMIT = 100;
const POSITION_POLL_MS = 500;
const POSITION_POLL_ATTEMPTS = 10;
const runningAccounts = new Set<string>();
let isExecuting = false;

type ClientFactory = (platform: Platform) => ProprClient;

type RunResult = {
  entryExecuted: boolean;
  entryBlocked: boolean;
  closed: boolean;
};

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { message?: unknown; cause?: unknown };
  return `${String(value.message ?? error)} ${value.cause ? errorText(value.cause) : ""}`;
}

export function isInsufficientBalanceError(error: unknown): boolean {
  return errorText(error).toLowerCase().includes("insufficient_balance");
}

export function entryCooldownRemaining(lastEntryAt: number | undefined, now = Date.now()): number {
  if (!lastEntryAt || !Number.isFinite(lastEntryAt)) return 0;
  return Math.max(0, ENTRY_COOLDOWN_MS - (now - lastEntryAt));
}

export function cooldownRemainingForTest(lastCloseAt: number | undefined, now = Date.now()): number {
  return cooldownRemaining(lastCloseAt, now);
}

export function copyTradeAccountsForTest(accounts: TradingAccount[]): TradingAccount[] {
  return accounts.filter((account) => account.platform === "propr");
}

export function masterTargetPosition(ema9: number, ema21: number, current: Position): Position {
  if (!Number.isFinite(ema9) || !Number.isFinite(ema21)) throw new Error("EMA values must be finite numbers");
  if (ema9 === ema21) return current;
  return ema9 > ema21 ? "LONG" : "SHORT";
}

function activePosition(positions: ProprPosition[]): ProprPosition | undefined {
  const active = positions.filter((position) => (position.status ?? "open") === "open" && Number(position.quantity) > 0);
  if (active.some((position) => position.positionSide !== "long" && position.positionSide !== "short")) {
    throw new Error("Active position has unknown side; refusing to trade");
  }
  const sides = new Set(active.map((position) => position.positionSide));
  if (sides.size > 1) throw new Error("Multiple active position sides detected; refusing to hedge");
  return active[0];
}

function positionState(position: ProprPosition | undefined): Position {
  if (position?.positionSide === "long") return "LONG";
  if (position?.positionSide === "short") return "SHORT";
  return "NONE";
}

function roundQuantity(value: number): number {
  return Number(value.toPrecision(8));
}

function entryQuantity(equity: number, entryPrice: number): number {
  if (!Number.isFinite(equity) || equity <= 0) throw new Error("Account equity must be positive");
  if (!Number.isFinite(config.marginFraction) || config.marginFraction <= 0 || config.marginFraction > 1) {
    throw new Error("MARGIN_FRACTION must be between 0 and 1");
  }
  return roundQuantity((equity * config.marginFraction * config.leverage) / entryPrice);
}

function protectedPrices(side: Side, entryPrice: number, quantity: number): { takeProfitPrice: number; stopLossPrice: number } {
  const targetDistance = config.targetPnl / quantity;
  const takeProfitPrice = side === "long" ? entryPrice + targetDistance : entryPrice - targetDistance;
  const stopLossPrice = side === "long" ? entryPrice - targetDistance : entryPrice + targetDistance;
  if (takeProfitPrice <= 0 || stopLossPrice <= 0) throw new Error("Calculated TP/SL price is invalid");
  return { takeProfitPrice, stopLossPrice };
}

function executionSymbol(account: TradingAccount): string {
  return account.platform === "e8" ? config.e8Symbol : config.symbol;
}

function accountStatePath(accountId: string): URL {
  const readable = accountId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(accountId).digest("hex").slice(0, 12);
  return new URL(`./.accounts/${readable || "account"}-${digest}.json`, import.meta.url);
}

async function ensureAccountState(accountId: string, symbol: string): Promise<URL> {
  const path = accountStatePath(accountId);
  try {
    await access(path);
  } catch {
    await mkdir(new URL("./.accounts/", import.meta.url), { recursive: true });
    await copyFile(config.accountsPath, path);
  }
  const state = await readAccounts(path);
  if (state.accountId !== undefined && state.accountId !== accountId) {
    throw new Error("Account state identity mismatch");
  }
  if (state.stateSymbol !== undefined && state.stateSymbol !== symbol) {
    await updateAccountState(path, {
      stateSymbol: symbol,
      observedPosition: "NONE",
      cooldownUntil: undefined,
      cooldownReason: undefined,
    });
  } else if (state.accountId !== accountId || state.stateSymbol !== symbol) {
    await updateAccountState(path, { accountId, stateSymbol: symbol });
  }
  return path;
}

async function enforceRiskLock(accountId: string, accountsPath: URL): Promise<boolean> {
  if (await checkRiskEngine(accountsPath)) return true;
  console.error(`[RISK LOCK] Account ${accountId} violated; skipping synchronization.`);
  return false;
}

async function healthWithRetry(platform: Platform, client: ProprClient): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const health = await client.health();
      if (health.status !== "OK") throw new Error(`${platform} health check failed: ${health.status}`);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, [500, 1_000, 2_000][attempt - 1]!));
    }
  }
}

async function waitUntilFlat(client: ProprClient, symbol: string): Promise<void> {
  for (let attempt = 0; attempt < POSITION_POLL_ATTEMPTS; attempt += 1) {
    if (!activePosition(await client.getPositions(symbol))) return;
    await new Promise((resolve) => setTimeout(resolve, POSITION_POLL_MS));
  }
  throw new Error("Position did not become flat after close; refusing to open opposite side");
}

async function cancelPendingOrders(client: ProprClient, symbol: string): Promise<void> {
  if (!client.listOrders || !client.cancelOrder) {
    if (await client.hasPendingOrders(symbol)) throw new Error("Cannot safely cancel pending orders on this client");
    return;
  }
  for (const order of await client.listOrders(symbol)) {
    if (order.orderId) await client.cancelOrder(order.orderId);
  }
}

async function closePosition(client: ProprClient, account: TradingAccount, symbol: string, position: ProprPosition): Promise<void> {
  await cancelPendingOrders(client, symbol);
  const side = position.positionSide === "long" ? "long" : position.positionSide === "short" ? "short" : null;
  if (!side) throw new Error("Cannot close position with unknown side");
  await client.submit_trade({
    side,
    positionSide: side,
    symbol,
    size: Number(position.quantity),
    sizeUnit: account.platform === "e8" ? "size" : undefined,
    closePosition: true,
  });
  await waitUntilFlat(client, symbol);
}

async function openPosition(
  client: ProprClient,
  account: TradingAccount,
  snapshot: AccountSnapshot,
  symbol: string,
  side: Side,
  entryPrice: number,
): Promise<void> {
  if (await client.hasPendingOrders(symbol)) throw new Error("Pending orders remain; refusing to open a new position");
  await client.setLeverage(symbol, config.leverage);
  const quantity = entryQuantity(snapshot.equity, entryPrice);
  if (quantity <= 0) throw new Error("Calculated entry quantity is not positive");
  const { takeProfitPrice, stopLossPrice } = protectedPrices(side, entryPrice, quantity);
  await client.submitProtectedTrade({
    side,
    symbol,
    quantity,
    quantityUnit: account.platform === "e8" ? "size" : undefined,
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
  });
  if (positionState(activePosition(await client.getPositions(symbol))) !== (side === "long" ? "LONG" : "SHORT")) {
    throw new Error("Entry position verification failed");
  }
}

async function synchronizeAccount(
  client: ProprClient,
  account: TradingAccount,
  target: Position,
  candles: Candle[],
  allowEntry: boolean,
): Promise<RunResult> {
  const symbol = executionSymbol(account);
  await client.setup(account.accountId);
  const accountsPath = await ensureAccountState(account.accountId, symbol);
  const snapshot = await client.refreshAccountSnapshot();
  await writeAccountSnapshot(accountsPath, { ...snapshot, accountId: account.accountId, platform: account.platform });
  if (!await enforceRiskLock(account.accountId, accountsPath)) return { entryExecuted: false, entryBlocked: true, closed: false };

  const position = activePosition(await client.getPositions(symbol));
  const current = positionState(position);
  const state = await readAccounts(accountsPath);
  const observed = state.observedPosition;
  const externallyClosed = current === "NONE" && observed !== undefined && observed !== "NONE";
  if (externallyClosed) {
    await updateAccountState(accountsPath, {
      observedPosition: "NONE",
      cooldownUntil: Date.now() + PROPR_COOLDOWN_MS,
      cooldownReason: "unknown",
    });
    console.warn(`[COPY] ${account.accountId} exit detected; blocking entries for 5 minutes`);
    return { entryExecuted: false, entryBlocked: true, closed: true };
  }
  if (current !== "NONE" && observed !== current) {
    await updateAccountState(accountsPath, { observedPosition: current });
  }
  const cooldownMs = cooldownUntilRemaining(state.cooldownUntil);
  if (cooldownMs > 0 && current === "NONE") {
    console.log(`[COPY] ${account.accountId} cooldown: ${Math.ceil(cooldownMs / 1000)}s remaining`);
    return { entryExecuted: false, entryBlocked: true, closed: false };
  }
  const actions = planPositionTransition(target, current);
  if (actions.length === 0) return { entryExecuted: false, entryBlocked: false, closed: false };
  if (actions[0]?.kind === "close") {
    if (!position) throw new Error("Close action has no active position");
    await closePosition(client, account, symbol, position);
    await updateAccountState(accountsPath, {
      observedPosition: "NONE",
      cooldownUntil: Date.now() + PROPR_COOLDOWN_MS,
      cooldownReason: "unknown",
    });
    return { entryExecuted: false, entryBlocked: false, closed: true };
  }
  if (!allowEntry) return { entryExecuted: false, entryBlocked: true, closed: false };
  const side = positionToSide(target);
  const entryPrice = candles.at(-1)?.close;
  if (!side || !entryPrice || !Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error("No valid entry signal or market price");
  await openPosition(client, account, snapshot, symbol, side, entryPrice);
  await updateAccountState(accountsPath, { observedPosition: target });
  return { entryExecuted: true, entryBlocked: false, closed: false };
}

async function runAccount(
  client: ProprClient,
  account: TradingAccount,
  candles: Candle[],
  target: Position,
  allowEntry: boolean,
): Promise<RunResult> {
  if (runningAccounts.has(account.accountId)) return { entryExecuted: false, entryBlocked: false, closed: false };
  runningAccounts.add(account.accountId);
  try {
    return await synchronizeAccount(client, account, target, candles, allowEntry);
  } catch (error) {
    if (isInsufficientBalanceError(error)) {
      console.warn(`[COPY] Skipping ${account.accountId}: insufficient balance`);
      return { entryExecuted: false, entryBlocked: true, closed: false };
    }
    console.error(`Pipeline cycle failed for ${account.platform} account ${account.accountId}`, error);
    return { entryExecuted: false, entryBlocked: true, closed: false };
  } finally {
    runningAccounts.delete(account.accountId);
  }
}

async function runAllAccounts(createClient: ClientFactory): Promise<void> {
  if (isExecuting) return;
  isExecuting = true;
  try {
    const accounts = copyTradeAccountsForTest(await loadTradingAccounts());
    const master = accounts.find((account) => account.role === "master");
    if (!master || accounts.length === 0 || accounts.some((account) => account.platform !== "propr")) {
      throw new Error("Copy trading requires Propr accounts and exactly one master");
    }
    const followers = accounts.filter((account) => account.role === "follower");
    const candles = await fetchHyperliquidCandles(config.hyperliquidSymbol, config.candleInterval, CANDLE_LIMIT);
    const masterClient = createClient(master.platform);
    await masterClient.setup(master.accountId);
    const masterPosition = activePosition(await masterClient.getPositions(executionSymbol(master)));
    const currentMaster = positionState(masterPosition);
    const completedCandles = candles;
    if (completedCandles.length < 21) throw new Error("No completed candle set available for strategy");
    const signalPrice = completedCandles.at(-1)?.close;
    if (!signalPrice || !Number.isFinite(signalPrice) || signalPrice <= 0) throw new Error("No valid completed signal candle");
    const ema9 = calculateEMA(completedCandles.map((candle) => candle.close), 9);
    const ema21 = calculateEMA(completedCandles.map((candle) => candle.close), 21);
    const classification = evaluateEmaCrossover(ema9, ema21, currentMaster);
    const target = classification === "UP" ? "LONG" : classification === "DOWN" ? "SHORT" : classification === "CLOSE" ? "NONE" : currentMaster;
    const masterState = await readAccounts(await ensureAccountState(master.accountId, executionSymbol(master)));
    const cooldownMs = cooldownUntilRemaining(masterState.cooldownUntil);
    if (cooldownMs > 0) console.log(`[COPY] Post-close cooldown: ${Math.ceil(cooldownMs / 1000)}s remaining`);

    const masterResult = await runAccount(masterClient, master, completedCandles, target, cooldownMs === 0);
    if (!masterResult.entryExecuted && !masterResult.closed && target !== currentMaster) {
      console.warn(`[COPY] Master ${master.accountId} did not confirm target ${target}; followers remain blocked`);
    }
    const blocked = cooldownMs > 0 || masterResult.closed || (target !== currentMaster && !masterResult.entryExecuted);
    for (const follower of followers) {
      const result = await runAccount(createClient(follower.platform), follower, completedCandles, target, !blocked);
      if (result.closed) console.log(`[COPY] ${follower.accountId} closed before synchronization`);
    }
  } catch (error) {
    console.error("Pipeline copy-trading cycle failed; no fallback order was attempted", error);
  } finally {
    isExecuting = false;
  }
}

function startLoop(createClient: ClientFactory): NodeJS.Timeout {
  void runAllAccounts(createClient);
  const timer = setInterval(() => { void runAllAccounts(createClient); }, config.loopMs);
  const stop = (): void => { clearInterval(timer); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return timer;
}

export async function startPipeline(): Promise<void> {
  const accounts = await loadTradingAccounts();
  if (accounts.length === 0 || accounts.some((account) => account.platform !== "propr") || accounts.filter((account) => account.role === "master").length !== 1) {
    throw new Error("No valid Propr master/follower registry configured");
  }
  const createClient: ClientFactory = (platform) => createPlatformClient(platform, DRY_RUN);
  await healthWithRetry("propr", createClient("propr"));
  console.log("[SYSTEM] Starting Propr master/follower copy pipeline...");
  console.warn(`Starting pipeline: master=${accounts.find((account) => account.role === "master")?.accountId}, followers=${accounts.filter((account) => account.role === "follower").map((account) => account.accountId).join(",")}, signal=${config.hyperliquidSymbol}, dryRun=${DRY_RUN}`);
  startLoop(createClient);
}

const launchedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launchedDirectly) {
  void startPipeline().catch((error: unknown) => {
    console.error("Pipeline initialization failed", error);
    process.exitCode = 1;
  });
}
