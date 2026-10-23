import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dashboard:dev"], { stdio: "inherit", shell: true }),
  spawn("npm", ["run", "pipeline:dev"], { stdio: "inherit", shell: true }),
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 250);
}

for (const child of children) child.once("exit", (code) => stop(code ?? 1));
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
