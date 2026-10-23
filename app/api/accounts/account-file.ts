import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const ACCOUNTS_DIR = join(process.cwd(), "src", ".accounts");

export function safeFileName(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function findAccountFile(accountId: string): Promise<string | null> {
  const files = (await readdir(ACCOUNTS_DIR).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".json"));
  const target = join(ACCOUNTS_DIR, `${safeFileName(accountId)}.json`);
  if (!files.includes(`${safeFileName(accountId)}.json`)) return null;

  const raw = await readFile(target, "utf8")
    .then((value) => JSON.parse(value) as { accountId?: unknown })
    .catch(() => null);
  if (raw?.accountId !== undefined && raw.accountId !== accountId) return null;
  return target;
}
