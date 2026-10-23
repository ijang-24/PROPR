import { access, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccounts, writeAccountSnapshot } from "./accounts.js";
import { loadTradingAccounts } from "./account-registry.js";
import { config } from "./config.js";
import { fetchHyperliquidCandles } from "./adapters/hyperliquid-market-data.js";
import { createPlatformClient } from "./adapters/platform-client.js";
import { checkRiskEngine } from "./risk-engine.js";
import { calculateEMA, evaluateEmaCrossover } from "./oscillator.js";
import { readQueueState, writeQueueState } from "./queue-state.js";
import type { Candle, Platform, Position, ProprClient, Side, TradingAccount } from "./types.js";

/** Defaults to safe dry-run mode unless `.env` sets DRY_RUN=false. */
export const DRY_RUN = config.dryRun;
const CANDLE_LIMIT = 100;
export const ENTRY_COOLDOWN_MS = 2 * 60_000;
const runningAccounts = new Set<string>();
let isExecuting = false;

type ClientFactory = (platform: Platform) => ProprClient;

type RunResult = {
  entryExecuted: boolean;
  entryBlocked: boolean;
};

export function isInsufficientBalanceError(error: unknown): boolean {
  return errorText(error).toLowerCase().includes("insufficient_balance");
}

export function entryCooldownRemaining(lastEntryAt: number | undefined, now = Date.now()): number {
  if (!lastEntryAt || !Number.isFinite(lastEntryAt)) return 0;
  return Math.max(0, ENTRY_COOLDOWN_MS - (now - lastEntryAt));
}

const HEALTH_RETRIES = 3;
const HEALTH_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { message?: unknown; cause?: unknown };
  return `${String(value.message ?? error)} ${value.cause ? errorText(value.cause) : ""}`;
}

function isRetryableHealthError(error: unknown): boolean {
  const message = errorText(error).toUpperCase();
  return message.includes("ETIMEDOUT")
    || message.includes("ECONNREFUSED")
    || message.includes("ECONNRESET")
    || message.includes("FETCH FAILED")
    || /(?:E8|PROPR) API 429\\b/.test(message)
    || /(?:E8|PROPR) API 5\\d\\d\\b/.test(message);
}

async function healthWithRetry(platform: Platform, client: ProprClient): Promise<void> {
  for (let attempt = 1; attempt <= HEALTH_RETRIES; attempt += 1) {
    try {
      const health = await client.health();
      if (health.status !== "OK") throw new Error(`${platform} health check failed: ${health.status}`);
      return;
    } catch (error) {
      if (!isRetryableHealthError(error) || attempt === HEALTH_RETRIES) throw error;
      const delayMs = HEALTH_RETRY_DELAYS_MS[attempt - 1] ?? HEALTH_RETRY_DELAYS_MS.at(-1)!;
      console.warn(`[HEALTH] ${platform} check failed (${attempt}/${HEALTH_RETRIES}); retrying in ${delayMs}ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function roundQuantity(value: number): number {
  return Number(value.toPrecision(8));
}

function executionSymbol(account: TradingAccount): string {
  return account.platform === "e8" ? config.e8Symbol : config.symbol;
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

async function enforceRiskLock(accountId: string, accountsPath: URL): Promise<boolean> {
  if (await checkRiskEngine(accountsPath)) return true;
  console.error(`[RISK LOCK] Account ${accountId} violated. Excluding account from entry queue.`);
  return false;
}

async function isAccountLocked(account: TradingAccount): Promise<boolean> {
  try {
    return (await readAccounts(accountStatePath(account.accountId))).locked === true;
  } catch {
    return false;
  }
}

async function activeAccounts(accounts: TradingAccount[]): Promise<TradingAccount[]> {
  const states = await Promise.all(accounts.map(async (account) => ({ account, locked: await isAccountLocked(account) })));
  return states.filter(({ locked }) => !locked).map(({ account }) => account);
}

let allAccountsLockedLogged = false;

async function runAccount(
  client: ProprClient,
  account: TradingAccount,
  candles: Candle[],
  allowEntry: boolean,
  cooldownRemainingMs = 0,
): Promise<RunResult> {
  if (runningAccounts.has(account.accountId)) return { entryExecuted: false, entryBlocked: false };
  runningAccounts.add(account.accountId);
  const symbol = executionSymbol(account);
  try {
    await client.setup(account.accountId);
    const accountsPath = await ensureAccountState(account.accountId);
    const accountSnapshot = await client.refreshAccountSnapshot();
    await writeAccountSnapshot(accountsPath, {
      ...accountSnapshot,
      accountId: account.accountId,
      platform: account.platform,
    });
    if (!await enforceRiskLock(account.accountId, accountsPath)) {
      return { entryExecuted: false, entryBlocked: true };
    }

    const actualPositions = await client.getPositions(symbol);
    const actualPosition = actualPositions[0];
    const previousPosition: Position = actualPosition?.positionSide === "long"
      ? "LONG"
      : actualPosition?.positionSide === "short"
        ? "SHORT"
        : "NONE";
    const marketPrice = actualPosition?.markPrice;
    if (candles.length < 21) throw new Error("At least 21 candles are required for EMA 21");
    const entryPrice = candles.at(-1)?.close;
    if (!entryPrice || !Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error("No valid market price available");

    const closes = candles.map((candle) => candle.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const classification = evaluateEmaCrossover(ema9, ema21, previousPosition);
    const side: Side | null = classification === "UP"
      ? "long"
      : classification === "DOWN"
        ? "short"
        : classification === "CLOSE" && previousPosition === "LONG"
          ? "long"
          : classification === "CLOSE" && previousPosition === "SHORT"
            ? "short"
            : null;
    const logPrefix = `[${DRY_RUN ? "DRY" : "LIVE"}] Account: ${account.accountId} (Platform: ${account.platform})`;
    const indicatorLog = `EMA9: ${ema9.toFixed(2)} | EMA21: ${ema21.toFixed(2)} | Pos: ${previousPosition}`;

    if (!side) {
      console.log(`${logPrefix} | ${indicatorLog} -> Action: HOLD${marketPrice ? ` | Mark: ${marketPrice}` : ""}`);
      return { entryExecuted: false, entryBlocked: false };
    }

    if (classification !== "CLOSE" && !allowEntry) {
      console.log(`${logPrefix} | ${indicatorLog} -> Action: ROTATION_SKIP`);
      return { entryExecuted: false, entryBlocked: false };
    }

    if (classification !== "CLOSE" && cooldownRemainingMs > 0) {
      const seconds = Math.ceil(cooldownRemainingMs / 1_000);
      console.log(`${logPrefix} | ${indicatorLog} -> Action: ENTRY_COOLDOWN (${seconds}s remaining)`);
      return { entryExecuted: false, entryBlocked: false };
    }

    const action = classification === "CLOSE" ? "CLOSE" : side === "long" ? "BUY" : "SELL";
    if (classification !== "CLOSE") {
      console.log(`${logPrefix} | Setup detected! Round-Robin selected Account: ${account.accountId} (Platform: ${account.platform}) | Action: ${action}`);
    }

    if (DRY_RUN) {
      console.log(`${logPrefix} | ${indicatorLog} -> Action: ${action}${marketPrice ? ` | Mark: ${marketPrice}` : ""}`);
      return { entryExecuted: classification !== "CLOSE", entryBlocked: false };
    }

    if (await client.hasPendingOrders(symbol)) {
      console.log(`${logPrefix} | ${indicatorLog} -> Action: WAIT_PENDING_ORDER`);
      return { entryExecuted: false, entryBlocked: false };
    }

    if (!await enforceRiskLock(account.accountId, accountsPath)) {
      return { entryExecuted: false, entryBlocked: true };
    }
    if (classification === "CLOSE") {
      if (!actualPosition) throw new Error("Close signal has no active position");
      const snapshot = await client.submit_trade({
        side,
        positionSide: previousPosition.toLowerCase() as Side,
        symbol,
        size: Number(actualPosition.quantity),
        sizeUnit: account.platform === "e8" ? "size" : undefined,
        closePosition: true,
      });
      await writeAccountSnapshot(accountsPath, {
        ...snapshot,
        accountId: account.accountId,
        platform: account.platform,
      });
      const verified = await client.getPositions(symbol);
      const verifiedPosition = verified[0]?.positionSide?.toUpperCase() ?? "NONE";
      console.log(`${logPrefix} | ${indicatorLog} -> Action: CLOSE | Verified Pos: ${verifiedPosition}`);
      return { entryExecuted: false, entryBlocked: false };
    }

    await client.setLeverage(symbol, config.leverage);
    const quantity = entryQuantity(accountSnapshot.equity, entryPrice);
    if (quantity <= 0) throw new Error("Calculated entry quantity is not positive");
    const { takeProfitPrice, stopLossPrice } = protectedPrices(side, entryPrice, quantity);
    const orders = await client.submitProtectedTrade({
      side,
      symbol,
      quantity,
      quantityUnit: account.platform === "e8" ? "size" : undefined,
      entryPrice,
      takeProfitPrice,
      stopLossPrice,
    });
    const verified = await client.getPositions(symbol);
    const verifiedPosition = verified[0]?.positionSide?.toUpperCase() ?? "NONE";
    console.log(`${logPrefix} | ${indicatorLog} -> Action: ${action} | Qty: ${quantity} | TP: ${takeProfitPrice} | SL: ${stopLossPrice} | Orders: ${orders.length} | Verified Pos: ${verifiedPosition}`);
    return { entryExecuted: true, entryBlocked: false };
  } catch (error) {
    if (isInsufficientBalanceError(error)) {
      console.warn(`[QUEUE] Skipping ${account.accountId}: Propr reported insufficient balance; rotating entry queue`);
      return { entryExecuted: false, entryBlocked: true };
    }
    console.error(`Pipeline cycle failed for ${account.platform} account ${account.accountId}; no retry/order fallback was attempted`, error);
    return { entryExecuted: false, entryBlocked: false };
  } finally {
    runningAccounts.delete(account.accountId);
  }
}

async function runAllAccounts(createClient: ClientFactory): Promise<void> {
  if (isExecuting) return;
  isExecuting = true;
  try {
    const configuredAccounts = await loadTradingAccounts();
    if (configuredAccounts.length === 0) {
      console.warn("[QUEUE] No local trading accounts configured; skipping cycle");
      return;
    }
    const accounts = await activeAccounts(configuredAccounts);
    if (accounts.length === 0) {
      if (!allAccountsLockedLogged) {
        console.warn("[QUEUE] All local trading accounts are risk-locked; pipeline paused");
        allAccountsLockedLogged = true;
      }
      return;
    }
    allAccountsLockedLogged = false;
    const candles = await fetchHyperliquidCandles(config.hyperliquidSymbol, config.candleInterval, CANDLE_LIMIT);
    const queue = await readQueueState(accounts.length);
    const selectedIndex = queue.nextAccountIndex;
    const selectedAccount = accounts[selectedIndex]!;
    const cooldownRemainingMs = entryCooldownRemaining(queue.lastEntryAt);
    if (cooldownRemainingMs > 0) {
      const totalSeconds = Math.ceil(cooldownRemainingMs / 1_000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      console.log(`[QUEUE] Entry cooldown active: ${minutes}m ${seconds}s remaining`);
    }
    const results = await Promise.all(accounts.map((account, index) => runAccount(
      createClient(account.platform),
      account,
      candles,
      index === selectedIndex,
      index === selectedIndex ? cooldownRemainingMs : 0,
    )));
    const selectedResult = results[selectedIndex];
    if (selectedResult?.entryExecuted || selectedResult?.entryBlocked) {
      const nextIndex = (selectedIndex + 1) % accounts.length;
      await writeQueueState({
        nextAccountIndex: nextIndex,
        ...(selectedResult.entryExecuted ? { lastEntryAt: Date.now() } : queue.lastEntryAt ? { lastEntryAt: queue.lastEntryAt } : {}),
      });
      const nextAccount = accounts[nextIndex];
      if (nextAccount) console.log(`[QUEUE] Next entry account: ${nextAccount.accountId} (${nextAccount.platform})`);
    } else if (selectedAccount) {
      console.log(`[QUEUE] Next entry account: ${selectedAccount.accountId} (${selectedAccount.platform})`);
    }
  } catch (error) {
    console.error("Pipeline market-data cycle failed; no account order was attempted", error);
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
  const accounts = await loadTradingAccounts();
  if (accounts.length === 0) throw new Error("No trading accounts configured");
  const createClient: ClientFactory = (platform) => createPlatformClient(platform, DRY_RUN);
  for (const platform of new Set(accounts.map((account) => account.platform))) {
    await healthWithRetry(platform, createClient(platform));
  }
  console.log("[SYSTEM] Starting Propr/E8 Pipeline...");
  console.warn(`Starting pipeline: accounts=${accounts.map((account) => `${account.accountId}:${account.platform}`).join(",")}, signal=${config.hyperliquidSymbol}, interval=${config.candleInterval}, dryRun=${DRY_RUN}`);
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
