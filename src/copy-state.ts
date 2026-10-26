import type { Position } from "./types.js";

export function masterCloseTimestamp(previous: Position, current: Position, now = Date.now()): number | undefined {
  return previous !== "NONE" && current === "NONE" ? now : undefined;
}
