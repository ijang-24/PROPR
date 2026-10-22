import { spawn } from "node:child_process";
import type { Candle, Classification } from "./types.js";

const allowed = new Set<Classification>(["UP", "DOWN", "CLOSE", "HOLD"]);

export function classifyWithOpenCode(command: string, candles: Candle[]): Promise<Classification> {
  const prompt = [
    "Return ONLY one JSON object, with no markdown and no explanation.",
    'The exact schema is {"classification":"UP"}, {"classification":"DOWN"}, {"classification":"CLOSE"}, or {"classification":"HOLD"}.',
    "Do not provide financial advice. Classify only the numeric OHLCV data below.",
    JSON.stringify(candles),
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`OpenCode exited ${code}: ${stderr.slice(0, 500)}`));
      try {
        const parsed = JSON.parse(stdout.trim()) as { classification?: unknown };
        if (typeof parsed.classification !== "string" || !allowed.has(parsed.classification as Classification)) {
          throw new Error("invalid classification");
        }
        resolve(parsed.classification as Classification);
      } catch (error) {
        reject(new Error(`OpenCode returned invalid JSON: ${String(error)}`));
      }
    });
    child.stdin.end(prompt);
  });
}
