import { readFile, writeFile } from "node:fs/promises";
import type { QueueState } from "./types.js";

const QUEUE_STATE_PATH = new URL("./.accounts/queue-state.json", import.meta.url);

export async function readQueueState(accountCount: number): Promise<QueueState> {
  if (accountCount <= 0) throw new Error("Queue requires at least one account");
  try {
    const value = JSON.parse(await readFile(QUEUE_STATE_PATH, "utf8")) as Partial<QueueState>;
    const index = Number(value.nextAccountIndex);
    const lastEntryAt = Number(value.lastEntryAt);
    return {
      nextAccountIndex: Number.isInteger(index) && index >= 0 ? index % accountCount : 0,
      ...(Number.isFinite(lastEntryAt) && lastEntryAt > 0 ? { lastEntryAt } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { nextAccountIndex: 0 };
  }
}

export async function writeQueueState(state: QueueState): Promise<void> {
  await writeFile(QUEUE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
