import type { ApiDashboardPayload } from "./ui-state.js";

export const scenarioA: ApiDashboardPayload = {
  statusCode: 200,
  updatedAt: "2026-10-22T09:00:00.000Z",
  account: {
    accountId: "acct_demo_001",
    status: "Active",
    initialBalance: 5000,
    balance: 5018,
    equity: 5020,
  },
  challenge: {
    challengeId: "challenge_demo_001",
    accountId: "acct_demo_001",
    status: "Running",
  },
  payout: { payoutId: null, status: "Requested", amount: 0 },
};

export const scenarioB: ApiDashboardPayload = {
  statusCode: 200,
  updatedAt: "2026-10-22T09:05:00.000Z",
  account: {
    accountId: "acct_demo_001",
    status: "Active",
    initialBalance: 5000,
    balance: 4952,
    equity: 4950,
  },
  challenge: {
    challengeId: "challenge_demo_001",
    accountId: "acct_demo_001",
    status: "Running",
  },
  payout: { payoutId: null, status: "Requested", amount: 0 },
};

export const scenarioC: ApiDashboardPayload = {
  statusCode: 200,
  updatedAt: "2026-10-22T09:10:00.000Z",
  account: {
    accountId: "acct_demo_001",
    status: "Active",
    initialBalance: 5000,
    balance: 4800,
    equity: 4800,
  },
  challenge: {
    challengeId: "challenge_demo_001",
    accountId: "acct_demo_001",
    status: "Running",
  },
  payout: { payoutId: null, status: "Requested", amount: 0 },
};

export const scenarioD503: ApiDashboardPayload = {
  statusCode: 503,
  error: "Service Unavailable",
};

export const scenarioDIncomplete: ApiDashboardPayload = {
  statusCode: 200,
  updatedAt: "2026-10-22T09:15:00.000Z",
  account: { accountId: "acct_demo_001", status: "Active" },
  challenge: null,
  payout: null,
};
