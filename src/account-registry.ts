import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { Platform, TradingAccount } from "./types.js";

const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9:_-]+$/;

function parsePlatform(value: unknown): Platform {
  if (value === "propr" || value === "e8") return value;
  throw new Error(`Unsupported account platform: ${String(value)}`);
}

function parseEntry(entry: unknown, source: string): TradingAccount {
  if (!entry || typeof entry !== "object") throw new Error(`${source} entries must be objects`);
  const item = entry as { accountId?: unknown; platform?: unknown };
  if (typeof item.accountId !== "string" || !item.accountId.trim()) {
    throw new Error(`${source} entries require accountId`);
  }
  return { accountId: item.accountId.trim(), platform: parsePlatform(item.platform) };
}

function parseRegistry(value: unknown, source: string): TradingAccount[] {
  if (!Array.isArray(value)) throw new Error(`${source} must contain an array`);
  return value.map((entry) => parseEntry(entry, source));
}

function validateAccountId(accountId: string): void {
  if (!accountId || !ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("Invalid account ID");
}

async function withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
  const target = fileURLToPath(config.tradingAccountsPath);
  const lockPath = `${target}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        return await operation();
      } finally {
        await rmdir(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Timed out waiting for account registry lock");
}

async function replaceRegistry(value: TradingAccount[]): Promise<void> {
  const target = fileURLToPath(config.tradingAccountsPath);
  const tmp = join(dirname(target), `.trading-accounts.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function readAccountFile(): Promise<TradingAccount[]> {
  try {
    return parseRegistry(JSON.parse(await readFile(config.tradingAccountsPath, "utf8")), "trading-accounts.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parseConfiguredAccounts(value: string | undefined): TradingAccount[] {
  if (!value?.trim()) return [];
  return parseRegistry(JSON.parse(value), "TRADING_ACCOUNTS");
}

export async function loadTradingAccounts(): Promise<TradingAccount[]> {
  const fileAccounts = await readAccountFile();
  if (fileAccounts.length > 0) return fileAccounts;
  const configured = parseConfiguredAccounts(process.env.TRADING_ACCOUNTS);
  if (configured.length > 0) return configured;
  return config.accountIds.map((accountId) => ({ accountId, platform: "propr" }));
}

export async function removeTradingAccount(accountId: string): Promise<void> {
  validateAccountId(accountId);
  await withRegistryLock(async () => {
    const accounts = await readAccountFile();
    if (accounts.length === 0) throw new Error("Local account registry is not configured");
    const index = accounts.findIndex((account) => account.accountId === accountId);
    if (index < 0) throw new Error("Account is not in the local registry");
    if (accounts.length <= 1) throw new Error("Cannot remove the only local account");
    const next = accounts.filter((account) => account.accountId !== accountId);
    await replaceRegistry(next);
  });
}
