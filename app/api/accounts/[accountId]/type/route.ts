import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findAccountFile } from "../../account-file.js";

type AccountType = "funded" | "challenge";
type AccountState = Record<string, unknown> & { accountId?: unknown };

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
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
  const body = await request.json().catch(() => null) as { accountType?: unknown } | null;
  if (body?.accountType !== "funded" && body?.accountType !== "challenge") {
    return Response.json({ error: "accountType must be funded or challenge" }, { status: 400 });
  }

  const target = await findAccountFile(accountId);
  if (!target) return Response.json({ error: "Account state not found" }, { status: 404 });
  try {
    await withFileLock(target, async () => {
      const current = JSON.parse(await readFile(pathToFileURL(target), "utf8")) as AccountState;
      if (current.accountId !== undefined && current.accountId !== accountId) throw new Error("Account identity mismatch");
      const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(
        tmp,
        `${JSON.stringify({ ...current, accountType: body.accountType, updated_at: new Date().toISOString() }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await replaceWithRetry(tmp, target);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Account identity mismatch") {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("Failed to update account type", error);
    return Response.json({ error: "Unable to update account type" }, { status: 500 });
  }
  return Response.json({ ok: true, accountId, accountType: body.accountType as AccountType });
}
