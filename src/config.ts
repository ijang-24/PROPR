import "dotenv/config";

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

export const config = {
  accountsPath: new URL("../accounts.json", import.meta.url),
  apiUrl: process.env.PROPR_API_URL ?? "https://api.propr.xyz/v1",
  accountId: process.env.PROPR_ACCOUNT_ID,
  symbol: process.env.PROPR_SYMBOL ?? "BTC",
  candleInterval: "15m",
  loopMs: 900_000,
  maxDailyLoss: 150, // 3% of the $5,000 initial balance
  profitLimit: 500,
  opencodeCommand: process.env.OPENCODE_COMMAND ?? "opencode",
  dryRun: true,
  orderSize: positiveInt("ORDER_SIZE", 1),
};
