import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findAccountFile } from "../../account-file.js";

type AccountState = {
  accountId?: unknown;
  initial_balance: number;
  equity: number;
  locked?: boolean;
  max_daily_loss: number;
  [key: string]: unknown;
};

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function validateAccount(value: unknown): AccountState {
  if (!value || typeof value !== "object") throw new Error("Invalid account state");
  const account = value as Partial<AccountState>;
  if (!Number.isFinite(account.initial_balance) || !Number.isFinite(account.equity) || !Number.isFinite(account.max_daily_loss)) {
    throw new Error("Invalid account risk fields");
  }
  return account as AccountState;
}

async function withFileLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
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
  throw new Error("Timed out waiting for account state lock");
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

export async function POST(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: "Same-origin request required" }, { status: 403 });
  const { accountId } = await context.params;
  const target = await findAccountFile(accountId);
  if (!target) return Response.json({ error: "Account state not found" }, { status: 404 });
  try {
    await withFileLock(target, async () => {
      const account = validateAccount(JSON.parse(await readFile(pathToFileURL(target), "utf8")));
      if (account.accountId !== undefined && account.accountId !== accountId) throw new Error("Account identity mismatch");
      const loss = account.initial_balance - account.equity;
      if (loss >= account.max_daily_loss) throw new Error("Risk limit is still breached; manual unlock refused");
      const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(
        tmp,
        `${JSON.stringify({ ...account, locked: false, updated_at: new Date().toISOString() }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await replaceWithRetry(tmp, target);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Account identity mismatch") return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Error && error.message === "Risk limit is still breached; manual unlock refused") return Response.json({ error: error.message }, { status: 409 });
    console.error("Failed to unlock account", error);
    return Response.json({ error: "Unable to unlock account" }, { status: 500 });
  }
  return Response.json({ ok: true, accountId });
}
