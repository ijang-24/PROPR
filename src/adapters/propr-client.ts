import { ulid } from "ulid";
import type { AccountSnapshot, Candle, ProprClient, TradeRequest } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

interface ChallengeAttempt {
  accountId?: unknown;
}

interface AccountResponse {
  balance?: unknown;
  totalUnrealizedPnl?: unknown;
  isolatedPositionMargin?: unknown;
}

interface OrderResponse {
  data?: unknown[];
}

export class OfficialProprClient implements ProprClient {
  private accountId: string | null = null;

  constructor(
    private readonly dryRun = true,
    private readonly apiKey = process.env.PROPR_API_KEY,
    private readonly baseUrl = process.env.PROPR_API_URL ?? "https://api.propr.xyz/v1",
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    if (!apiKey) throw new Error("PROPR_API_KEY is required");
  }

  private async request<T>(method: string, path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey!,
          ...(process.env.PROPR_BUILDER_CODE ? { "X-Builder-Code": process.env.PROPR_BUILDER_CODE } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = text; }
      }
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "message" in payload
          ? String(payload.message)
          : `HTTP ${response.status}`;
        throw new Error(`Propr API ${response.status}: ${message}`);
      }
      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(): Promise<{ status: string }> {
    return this.request<{ status: string }>("GET", "/health");
  }

  async getUser(): Promise<unknown> {
    return this.request("GET", "/users/me");
  }

  async setup(accountId = process.env.PROPR_ACCOUNT_ID): Promise<string> {
    if (accountId) {
      this.accountId = accountId;
      return accountId;
    }
    const response = await this.request<{ data?: ChallengeAttempt[] }>("GET", "/challenge-attempts", undefined, {
      status: "active",
      limit: "20",
      offset: "0",
    });
    const discovered = response.data?.find((attempt) => typeof attempt.accountId === "string")?.accountId;
    if (typeof discovered !== "string") throw new Error("No active Propr challenge account found");
    this.accountId = discovered;
    return discovered;
  }

  private accountPath(path: string): string {
    if (!this.accountId) throw new Error("Propr account is not initialized; call setup() first");
    return `/accounts/${this.accountId}${path}`;
  }

  async refreshAccountSnapshot(): Promise<AccountSnapshot> {
    const account = await this.request<AccountResponse>("GET", this.accountPath(""));
    const balance = Number(account.balance);
    const unrealizedPnl = Number(account.totalUnrealizedPnl ?? 0);
    const isolatedMargin = Number(account.isolatedPositionMargin ?? 0);
    if (![balance, unrealizedPnl, isolatedMargin].every(Number.isFinite)) {
      throw new Error("Propr account response contains non-numeric equity fields");
    }
    return { balance, equity: balance + unrealizedPnl + isolatedMargin };
  }

  async fetchCandles(_symbol: string, _interval: string, _limit: number): Promise<Candle[]> {
    throw new Error("Propr official API documents no candle/klines endpoint; refusing to invent one");
  }

  async submit_trade(request: TradeRequest): Promise<AccountSnapshot> {
    if (this.dryRun) return this.refreshAccountSnapshot();
    const side = request.side === "long" ? "buy" : "sell";
    const order = {
      accountId: this.accountId,
      intentId: ulid(),
      exchange: "hyperliquid",
      type: "market",
      side,
      positionSide: request.side,
      productType: "perp",
      timeInForce: "IOC",
      asset: request.symbol,
      base: request.symbol,
      quote: "USDC",
      quantity: String(request.size),
      reduceOnly: false,
      closePosition: false,
    };
    await this.request<OrderResponse>("POST", this.accountPath("/orders"), { orders: [order] });
    return this.refreshAccountSnapshot();
  }
}
