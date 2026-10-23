import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { OfficialProprClient } from "./adapters/propr-client.js";

const LEVERAGE = 4;
const MARGIN_FRACTION = 0.5;
const PNL_TARGET = 25;
const CANDLE_LIMIT = 15;

function roundQuantity(value: number): number {
  return Number(value.toPrecision(8));
}

function priceForShortPnl(entryPrice: number, quantity: number, pnl: number): number {
  return entryPrice + pnl / quantity;
}

async function runAccount(accountId: string): Promise<void> {
  const client = new OfficialProprClient(false, process.env.PROPR_API_KEY, config.apiUrl);
  await client.setup(accountId);

  const positions = await client.getPositions(config.symbol);
  if (positions.length > 0) {
    console.log(`[SKIP] ${accountId}: active ${config.symbol} position exists`);
    return;
  }
  if (await client.hasPendingOrders(config.symbol)) {
    console.log(`[SKIP] ${accountId}: pending/open ${config.symbol} order exists`);
    return;
  }

  const snapshot = await client.refreshAccountSnapshot();
  const candles = await client.fetchCandles(config.symbol, config.candleInterval, CANDLE_LIMIT);
  const entryPrice = candles.at(-1)?.close;
  if (!entryPrice || !Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error("No valid market price available");

  const margin = snapshot.equity * MARGIN_FRACTION;
  const quantity = roundQuantity((margin * LEVERAGE) / entryPrice);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid quantity for equity ${snapshot.equity}`);

  const takeProfitPrice = priceForShortPnl(entryPrice, quantity, -PNL_TARGET);
  const stopLossPrice = priceForShortPnl(entryPrice, quantity, PNL_TARGET);
  if (takeProfitPrice <= 0) throw new Error("Calculated take-profit price is invalid");

  await client.setLeverage(config.symbol, LEVERAGE);
  const orders = await client.submitOneShotShort({
    symbol: config.symbol,
    quantity,
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
  });
  const verified = await client.getPositions(config.symbol);
  const shortPosition = verified.find((position) => position.positionSide === "short");
  if (!shortPosition) throw new Error("Entry response returned but short position was not verified");

  console.log(
    `[LIVE TEST] ${accountId} | SHORT ${config.symbol} | qty=${quantity} | ` +
    `entry≈${entryPrice} | TP=${takeProfitPrice} | SL=${stopLossPrice} | ` +
    `orders=${orders.length} | verified=${shortPosition.positionSide}`,
  );
}

async function main(): Promise<void> {
  if (config.dryRun) throw new Error("Set DRY_RUN=false in .env for the one-shot live test");
  if (!process.env.PROPR_API_KEY) throw new Error("PROPR_API_KEY is required");
  if (config.accountIds.length === 0) throw new Error("PROPR_ACCOUNT_ID or PROPR_ACCOUNT_IDS is required");

  const health = await new OfficialProprClient(false, process.env.PROPR_API_KEY, config.apiUrl).health();
  if (health.status !== "OK") throw new Error(`Propr health check failed: ${health.status}`);
  for (const accountId of config.accountIds) {
    try {
      await runAccount(accountId);
    } catch (error) {
      console.error(`[FAIL] ${accountId}:`, error instanceof Error ? error.message : error);
    }
  }
}

const launchedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (launchedDirectly) {
  void main().catch((error: unknown) => {
    console.error("One-shot test failed", error);
    process.exitCode = 1;
  });
}

export { priceForShortPnl };
