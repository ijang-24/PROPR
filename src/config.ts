import "dotenv/config";

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

export const config = {
  accountsPath: new URL("../accounts.json", import.meta.url),
  tradingAccountsPath: new URL("../trading-accounts.json", import.meta.url),
  apiUrl: process.env.PROPR_API_URL ?? "https://api.propr.xyz/v1",
  accountIds: [...new Set((process.env.PROPR_ACCOUNT_IDS ?? process.env.PROPR_ACCOUNT_ID ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean))],
  symbol: process.env.PROPR_SYMBOL ?? process.env.SYMBOL ?? "XYZ100-USDC",
  hyperliquidSymbol: process.env.HYPERLIQUID_SYMBOL ?? "xyz:XYZ100",
  e8Symbol: process.env.E8_SYMBOL ?? "XYZ100",
  candleInterval: process.env.CANDLE_INTERVAL ?? "1m",
  loopMs: positiveInt("LOOP_MS", 1_000),
  maxDailyLoss: 100, // Maximum daily loss; warning threshold is 50
  profitLimit: 500,
  opencodeCommand: process.env.OPENCODE_COMMAND ?? "opencode",
  dryRun: (process.env.DRY_RUN ?? "true").trim().toLowerCase() !== "false",
  leverage: positiveInt("LEVERAGE", 4),
  marginFraction: Number(process.env.MARGIN_FRACTION ?? 0.5),
  targetPnl: positiveInt("TARGET_PNL", 25),
  stopPnl: positiveInt("STOP_PNL", 25),
  orderSize: positiveInt("ORDER_SIZE", 1),
};
