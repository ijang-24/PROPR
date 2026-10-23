import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findAccountFile } from "../account-file.js";

const REGISTRY_PATH = join(process.cwd(), "trading-accounts.json");

function validAccountId(accountId: string): boolean {
  return /^[a-zA-Z0-9:_-]+$/.test(accountId);
}

async function removeFromRegistry(accountId: string): Promise<void> {
  if (!validAccountId(accountId)) throw new Error("Invalid account ID");
  const lockPath = `${REGISTRY_PATH}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        const accounts = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as Array<{ accountId?: unknown; platform?: unknown }>;
        if (!Array.isArray(accounts)) throw new Error("Local account registry is malformed");
        const index = accounts.findIndex((account) => account?.accountId === accountId);
        if (index < 0) throw new Error("Account is not in the local registry");
        if (accounts.length <= 1) throw new Error("Cannot remove the only local account");
        const tmp = join(dirname(REGISTRY_PATH), `.${basename(REGISTRY_PATH)}.${process.pid}.${Date.now()}.tmp`);
        try {
          await writeFile(tmp, `${JSON.stringify(accounts.filter((_, itemIndex) => itemIndex !== index), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(tmp, REGISTRY_PATH);
        } finally {
          await unlink(tmp).catch(() => undefined);
        }
      } finally {
        await rmdir(lockPath).catch(() => undefined);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Timed out waiting for account registry lock");
}

async function removeLocalAccount(accountId: string, statePath: string): Promise<void> {
  await removeFromRegistry(accountId);
  try {
    await unlink(statePath);
  } catch (error) {
    throw new Error(`Registry updated but local state removal failed: ${String(error)}`);
  }
}


type AccountState = {
  accountId?: unknown;
  currentPosition?: unknown;
  position?: unknown;
  positionSide?: unknown;
  quantity?: unknown;
};

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function hasOpenPosition(account: AccountState): boolean {
  const position = account.currentPosition ?? account.positionSide ?? account.position;
  if (typeof position === "string" && ["LONG", "SHORT"].includes(position.toUpperCase())) return true;
  const quantity = Number(account.quantity);
  return Number.isFinite(quantity) && quantity !== 0;
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

export async function DELETE(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: "Same-origin request required" }, { status: 403 });
  const { accountId } = await context.params;
  const target = await findAccountFile(accountId);
  if (!target) return Response.json({ error: "Account state not found" }, { status: 404 });

  try {
    await withFileLock(target, async () => {
      const account = JSON.parse(await readFile(pathToFileURL(target), "utf8")) as AccountState;
      if (account.accountId !== undefined && account.accountId !== accountId) throw new Error("Account identity mismatch");
      if (hasOpenPosition(account)) throw new Error("Close the remote position before removing this local account");
      await removeLocalAccount(accountId, target);
    });
  } catch (error) {
    if (error instanceof Error && [
      "Invalid account ID",
      "Account is not in the local registry",
      "Cannot remove the only local account",
      "Local account registry is not configured",
      "Close the remote position before removing this local account",
      "Account identity mismatch",
    ].includes(error.message)) {
      return Response.json({ error: error.message }, { status: error.message === "Account is not in the local registry" ? 404 : 409 });
    }
    console.error("Failed to remove local account", error);
    return Response.json({ error: "Unable to remove local account" }, { status: 500 });
  }
  return new Response(null, { status: 204 });
}
