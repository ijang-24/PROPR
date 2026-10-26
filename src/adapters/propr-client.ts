import { ulid } from "ulid";
import { fetchHyperliquidCandles } from "./hyperliquid-market-data.js";
import type {
  AccountSnapshot,
  Candle,
  OneShotOrderResult,
  OneShotShortRequest,
  ProprClient,
  ProprOrder,
  ProprOrderResponse,
  ProprPosition,
  ProtectedTradeRequest,
  TradeRequest,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

interface ChallengeAttempt {
  accountId?: unknown;
}

interface AccountResponse {
  balance?: unknown;
  totalUnrealizedPnl?: unknown;
  isolatedPositionMargin?: unknown;
}

interface MarginConfigResponse {
  configId?: string;
  asset?: string;
  marginMode?: string;
  leverage?: string | number;
}

interface PositionsResponse {
  data?: ProprPosition[];
}

function proprAsset(symbol: string): { asset: string; base: string; marginAsset: string } {
  const value = symbol.trim();
  if (value.includes("/")) throw new Error(`Invalid Propr symbol: ${symbol}`);
  if (value.toUpperCase() === "XYZ100-USDC") {
    return { asset: "xyz:XYZ100", base: "XYZ100", marginAsset: "xyz:XYZ100" };
  }
  const [basePart, quote] = value.split("-");
  if (!basePart) throw new Error(`Invalid Propr symbol: ${symbol}`);
  if (quote && quote.toUpperCase() !== "USDC") throw new Error(`Unsupported Propr quote: ${quote}`);
  const asset = basePart.includes(":") ? basePart : basePart.toUpperCase();
  return {
    asset,
    base: basePart.includes(":") ? basePart.slice(basePart.indexOf(":") + 1) : basePart.toUpperCase(),
    marginAsset: asset,
  };
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

  async getPositions(symbol?: string): Promise<ProprPosition[]> {
    const params: Record<string, string> = { limit: "100", offset: "0" };
    if (symbol) params.asset = proprAsset(symbol).asset;
    const response = await this.request<PositionsResponse>("GET", this.accountPath("/positions"), undefined, params);
    return (response.data ?? []).filter((position) => (position.status ?? "open") === "open" && Number(position.quantity) > 0);
  }

  async listOrders(symbol: string): Promise<ProprOrder[]> {
    const { base } = proprAsset(symbol);
    const orders: ProprOrder[] = [];
    for (const status of ["pending", "open", "partially_filled"]) {
      const response = await this.request<ProprOrderResponse>("GET", this.accountPath("/orders"), undefined, {
        base,
        status,
        limit: "100",
        offset: "0",
      });
      orders.push(...(response.data ?? []));
    }
    return orders;
  }

  async hasPendingOrders(symbol: string): Promise<boolean> {
    return (await this.listOrders(symbol)).length > 0;
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!orderId.trim()) throw new Error("Propr order ID is required");
    try {
      await this.request("POST", this.accountPath(`/orders/${encodeURIComponent(orderId)}/cancel`));
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!message.includes("Propr API 400") || !message.includes("13053")) throw error;
    }
  }

  async cancelOpenOrders(symbol: string): Promise<void> {
    for (const order of await this.listOrders(symbol)) {
      if (order.orderId) await this.cancelOrder(order.orderId);
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!Number.isInteger(leverage) || leverage <= 0) throw new Error("Leverage must be a positive integer");
    const { marginAsset } = proprAsset(symbol);
    const config = await this.request<MarginConfigResponse>("GET", this.accountPath(`/margin-config/${encodeURIComponent(marginAsset)}`));
    if (!config.configId) throw new Error(`No margin config found for ${marginAsset}`);
    await this.request("PUT", this.accountPath(`/margin-config/${encodeURIComponent(config.configId)}`), {
      exchange: "hyperliquid",
      asset: marginAsset,
      marginMode: config.marginMode === "isolated" ? "isolated" : "cross",
      leverage,
    });
  }

  async fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    return fetchHyperliquidCandles(symbol, interval, limit);
  }

  async submit_trade(request: TradeRequest): Promise<AccountSnapshot> {
    if (this.dryRun) return this.refreshAccountSnapshot();

    const positionSide = request.positionSide ?? request.side;
    const side = request.closePosition
      ? positionSide === "long" ? "sell" : "buy"
      : request.side === "long" ? "buy" : "sell";
    const { asset, base } = proprAsset(request.symbol);
    const entry = {
      accountId: this.accountId,
      intentId: ulid(),
      exchange: "hyperliquid",
      type: "market",
      side,
      positionSide,
      productType: "perp",
      timeInForce: "IOC",
      asset,
      base,
      quote: "USDC",
      quantity: String(request.size),
      reduceOnly: request.closePosition ?? false,
      closePosition: request.closePosition ?? false,
    };
    const response = await this.request<ProprOrderResponse>("POST", this.accountPath("/orders"), {
      orders: [entry],
    });
    if (!response.data?.length) throw new Error("Propr accepted no orders");
    const rejected = response.data.find((order) => order.status === "rejected");
    if (rejected) throw new Error(`Propr rejected order ${rejected.intentId ?? "unknown"}`);
    return this.refreshAccountSnapshot();
  }

  async submitProtectedTrade(request: ProtectedTradeRequest): Promise<OneShotOrderResult[]> {
    if (this.dryRun) throw new Error("Protected live trade requires DRY_RUN=false");
    if (![request.quantity, request.entryPrice, request.takeProfitPrice, request.stopLossPrice].every(Number.isFinite)) {
      throw new Error("Protected trade values must be finite");
    }
    const { asset, base } = proprAsset(request.symbol);
    const positionSide = request.side;
    const exchangeSide = request.side === "long" ? "buy" : "sell";
    const closeSide = request.side === "long" ? "sell" : "buy";
    const groupId = ulid();
    const common = {
      accountId: this.accountId,
      exchange: "hyperliquid",
      positionSide,
      productType: "perp",
      asset,
      base,
      quote: "USDC",
      quantity: String(request.quantity),
    };
    const orders = [
      {
        ...common,
        intentId: ulid(),
        type: "market",
        side: exchangeSide,
        timeInForce: "IOC",
        reduceOnly: false,
        closePosition: false,
      },
      {
        ...common,
        intentId: ulid(),
        type: request.side === "long" ? "take_profit_market" : "take_profit_market",
        side: closeSide,
        timeInForce: "GTC",
        triggerPrice: String(request.takeProfitPrice),
        reduceOnly: true,
        closePosition: false,
      },
      {
        ...common,
        intentId: ulid(),
        type: "stop_market",
        side: closeSide,
        timeInForce: "GTC",
        triggerPrice: String(request.stopLossPrice),
        reduceOnly: true,
        closePosition: false,
      },
    ];
    const response = await this.request<ProprOrderResponse>("POST", this.accountPath("/orders"), {
      orderGroupId: groupId,
      orders,
    });
    if (!response.data?.length) throw new Error("Propr accepted no protected trade orders");
    const rejected = response.data.find((order) => order.status === "rejected");
    if (rejected) throw new Error(`Propr rejected protected trade order ${rejected.intentId ?? "unknown"}`);
    return response.data.map(({ orderId, status, type }) => ({ orderId, status, type }));
  }

  async submitOneShotShort(request: OneShotShortRequest): Promise<OneShotOrderResult[]> {
    return this.submitProtectedTrade({ ...request, side: "short" });
  }
}
