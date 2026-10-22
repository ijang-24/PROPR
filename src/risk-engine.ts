import { lockAccount, readAccounts } from "./accounts.js";
import type { AccountState } from "./types.js";

export async function checkRiskEngine(accountsPath: URL): Promise<boolean> {
  let account: AccountState;
  try {
    account = await readAccounts(accountsPath);
  } catch (error) {
    console.error("Risk lock: cannot read accounts.json", error);
    return false;
  }
  const loss = account.initial_balance - account.equity;
  const safe = account.locked !== true && loss < account.max_daily_loss;
  if (!safe) {
    await lockAccount(accountsPath).catch((error) => console.error("Risk lock persistence failed", error));
    console.error(`Risk lock: loss=${loss}, limit=${account.max_daily_loss}`);
  }
  return safe;
}
