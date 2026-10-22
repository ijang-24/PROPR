export const EVALUATION_RULES = {
  initialBalance: 5_000,
  warningDrop: 50,
  maxDailyDrawdown: 100,
  warningEquity: 4_950,
  violationEquity: 4_900,
} as const;

export type AccountMachineState = "Created" | "Active" | "Violated" | "Passed";
export type ChallengeMachineState = "Pending" | "Running" | "Failed" | "Passed";
export type PayoutMachineState = "Requested" | "Processing" | "Approved" | "Rejected";
export type RiskMachineState = "Safe" | "Warning" | "Violation";
export type DashboardDataStatus = "Ready" | "Degraded" | "Unavailable";

export interface AccountMachine {
  state: AccountMachineState;
  initialBalance: number;
  balance: number;
  equity: number;
  drawdown: number;
}

export interface ChallengeMachine {
  state: ChallengeMachineState;
  challengeId: string | null;
  accountId: string | null;
}

export interface PayoutMachine {
  state: PayoutMachineState;
  payoutId: string | null;
  amount: number;
}

export interface RiskMachine {
  state: RiskMachineState;
  equity: number;
  drawdown: number;
  warningThreshold: number;
  violationThreshold: number;
}

export interface DashboardState {
  dataStatus: DashboardDataStatus;
  error: string | null;
  updatedAt: string | null;
  account: AccountMachine;
  challenge: ChallengeMachine;
  payout: PayoutMachine;
  risk: RiskMachine;
}

export interface ApiDashboardPayload {
  statusCode?: unknown;
  error?: unknown;
  updatedAt?: unknown;
  account?: {
    accountId?: unknown;
    status?: unknown;
    initialBalance?: unknown;
    initial_balance?: unknown;
    balance?: unknown;
    equity?: unknown;
  } | null;
  challenge?: {
    challengeId?: unknown;
    accountId?: unknown;
    status?: unknown;
  } | null;
  payout?: {
    payoutId?: unknown;
    status?: unknown;
    amount?: unknown;
  } | null;
}

const ACCOUNT_STATES = new Set<AccountMachineState>(["Created", "Active", "Violated", "Passed"]);
const CHALLENGE_STATES = new Set<ChallengeMachineState>(["Pending", "Running", "Failed", "Passed"]);
const PAYOUT_STATES = new Set<PayoutMachineState>(["Requested", "Processing", "Approved", "Rejected"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function state<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? value as T : fallback;
}

function riskForEquity(equity: number): RiskMachineState {
  if (equity <= EVALUATION_RULES.violationEquity) return "Violation";
  if (equity <= EVALUATION_RULES.warningEquity) return "Warning";
  return "Safe";
}

function isUnavailable(payload: Record<string, unknown>): boolean {
  return payload.statusCode === 503 || payload.statusCode === "503";
}

export function mapApiStateToUI(input: unknown): DashboardState {
  const payload = record(input);
  const account = record(payload.account);
  const challenge = record(payload.challenge);
  const payout = record(payload.payout);
  const initialBalance = finite(account.initialBalance ?? account.initial_balance, EVALUATION_RULES.initialBalance);
  const balance = finite(account.balance, initialBalance);
  const equity = finite(account.equity, balance);
  const drawdown = Math.max(0, initialBalance - equity);
  const riskState = riskForEquity(equity);
  const unavailable = isUnavailable(payload);
  const complete = payload.account !== null && payload.account !== undefined && account.equity !== undefined;
  const dataStatus: DashboardDataStatus = unavailable ? "Unavailable" : complete ? "Ready" : "Degraded";
  const rawAccountState = state(account.status, ACCOUNT_STATES, "Created");

  return {
    dataStatus,
    error: unavailable ? String(payload.error ?? "Service unavailable") : complete ? null : "Incomplete dashboard payload",
    updatedAt: nullableString(payload.updatedAt),
    account: {
      state: riskState === "Violation" ? "Violated" : rawAccountState,
      initialBalance,
      balance,
      equity,
      drawdown,
    },
    challenge: {
      state: state(challenge.status, CHALLENGE_STATES, "Pending"),
      challengeId: nullableString(challenge.challengeId),
      accountId: nullableString(challenge.accountId ?? account.accountId),
    },
    payout: {
      state: state(payout.status, PAYOUT_STATES, "Requested"),
      payoutId: nullableString(payout.payoutId),
      amount: finite(payout.amount, 0),
    },
    risk: {
      state: riskState,
      equity,
      drawdown,
      warningThreshold: EVALUATION_RULES.warningEquity,
      violationThreshold: EVALUATION_RULES.violationEquity,
    },
  };
}
