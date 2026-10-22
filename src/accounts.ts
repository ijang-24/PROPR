import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountState, AccountSnapshot } from "./types.js";

function validateAccount(value: unknown): AccountState {
  if (!value || typeof value !== "object") throw new Error("accounts.json must contain an object");
  const account = value as Partial<AccountState>;
  for (const key of ["initial_balance", "balance", "equity", "max_daily_loss"] as const) {
    if (!Number.isFinite(account[key])) throw new Error(`accounts.json: invalid ${key}`);
  }
  if (account.initial_balance! < 0 || account.balance! < 0 || account.equity! < 0 || account.max_daily_loss! < 0) {
    throw new Error("accounts.json: values cannot be negative");
  }
  return account as AccountState;
}

export async function readAccounts(path: URL): Promise<AccountState> {
  return validateAccount(JSON.parse(await readFile(path, "utf8")));
}

async function replaceWithRetry(tmp: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  try {
    await writeFile(target, await readFile(tmp, "utf8"), { encoding: "utf8", mode: 0o600 });
    await unlink(tmp).catch(() => undefined);
  } catch {
    throw lastError;
  }
}

export async function writeAccountSnapshot(path: URL, snapshot: AccountSnapshot): Promise<void> {
  const current = await readAccounts(path);
  const next: AccountState = { ...current, ...snapshot, updated_at: new Date().toISOString() };
  const target = fileURLToPath(path);
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await replaceWithRetry(tmp, target);
}

export async function lockAccount(path: URL): Promise<void> {
  const current = await readAccounts(path);
  const target = fileURLToPath(path);
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify({ ...current, locked: true, updated_at: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await replaceWithRetry(tmp, target);
}

