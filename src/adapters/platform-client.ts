import { E8Client } from "./e8-client.js";
import { OfficialProprClient } from "./propr-client.js";
import type { Platform, ProprClient } from "../types.js";

export function createPlatformClient(platform: Platform, dryRun: boolean): ProprClient {
  if (platform === "e8") return new E8Client(dryRun);
  return new OfficialProprClient(dryRun);
}
