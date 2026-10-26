import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

async function withAccountLock<T>(path: URL, operation: () => Promise<T>): Promise<T> {
  const target = fileURLToPath(path);
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
  throw new Error(`Timed out waiting for account state lock: ${target}`);
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

async function writeAccountState(path: URL, next: AccountState): Promise<void> {
  const target = fileURLToPath(path);
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await replaceWithRetry(tmp, target);
}

export async function writeAccountSnapshot(path: URL, snapshot: AccountSnapshot): Promise<void> {
  await withAccountLock(path, async () => {
    const current = await readAccounts(path);
    await writeAccountState(path, { ...current, ...snapshot, updated_at: new Date().toISOString() });
  });
}

export async function updateAccountState(path: URL, update: Partial<AccountState>): Promise<AccountState> {
  return withAccountLock(path, async () => {
    const current = await readAccounts(path);
    const next = { ...current, ...update, updated_at: new Date().toISOString() };
    await writeAccountState(path, next);
    return next;
  });
}

export async function lockAccount(path: URL): Promise<void> {
  await updateAccountState(path, { locked: true });
}

export async function unlockAccount(path: URL): Promise<void> {
  await updateAccountState(path, { locked: false });
}

export async function setAccountType(path: URL, accountType: "funded" | "challenge"): Promise<AccountState> {
  return updateAccountState(path, { accountType });
}

export function accountFilePath(accountId: string, directory: string): string {
  const readable = accountId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(accountId).digest("hex").slice(0, 12);
  return join(directory, `${readable || "account"}-${digest}.json`);
}

export { validateAccount };
