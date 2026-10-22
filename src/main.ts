import { config } from "./config.js";
import { runOnce } from "./pipeline.js";
import { OfficialProprClient } from "./adapters/propr-client.js";

const client = new OfficialProprClient(config.dryRun);
const health = await client.health();
if (health.status !== "OK") throw new Error(`Propr health check failed: ${health.status}`);
const accountId = await client.setup(config.accountId);
console.warn(`Starting pipeline: account=${accountId}, symbol=${config.symbol}, interval=${config.candleInterval}, dryRun=${config.dryRun}`);

await runOnce(client);
const timer = setInterval(() => { void runOnce(client); }, config.loopMs);
process.once("SIGINT", () => { clearInterval(timer); process.exit(0); });
process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });
