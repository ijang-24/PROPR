import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const ACCOUNTS_DIR = join(process.cwd(), "src", ".accounts");

export function safeFileName(accountId) {
  const readable = accountId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(accountId).digest("hex").slice(0, 12);
  return `${readable || "account"}-${digest}`;
}

export async function findAccountFile(accountId) {
  const files = (await readdir(ACCOUNTS_DIR).catch(() => []))
    .filter((file) => file.endsWith(".json"));
  const fileName = `${safeFileName(accountId)}.json`;
  if (!files.includes(fileName)) return null;
  const target = join(ACCOUNTS_DIR, fileName);
  const raw = await readFile(target, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => null);
  if (raw?.accountId !== undefined && raw.accountId !== accountId) return null;
  return target;
}
