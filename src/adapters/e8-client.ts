import { ulid } from "ulid";
import type {
  AccountSnapshot,
  Candle,
  E8AccountMetadata,
  E8InstrumentMetadata,
  E8MetadataSummary,
  OneShotOrderResult,
  OneShotShortRequest,
  ProtectedTradeRequest,
  ProprClient,
  ProprPosition,
  QuantityMode,
  E8AssetClass,
  TradeRequest,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = objectValue(value);
  for (const key of ["data", "candles", "assets", "items", "results", "tools"]) {
    if (Array.isArray(object[key])) return object[key];
  }
  return [];
}

function parseToolText(value: unknown): unknown {
  const result = objectValue(value);
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item) => objectValue(item).text)
    .find((item): item is string => typeof item === "string");
  if (text === undefined) return value;
  try { return JSON.parse(text); } catch { return text; }
}

function toolNames(value: unknown): Set<string> {
  const tools = arrayValue(value);
  return new Set(tools.map((tool) => objectValue(tool).name).filter((name): name is string => typeof name === "string"));
}

function rawObject(value: unknown): Record<string, unknown> {
  return { ...objectValue(value) };
}

function explicitQuantityMode(value: JsonObject): QuantityMode {
  const mode = value.quantityMode ?? value.sizeUnit ?? value.amountUnit ?? value.unit;
  return mode === "lots" || mode === "contracts" || mode === "size" ? mode : "unknown";
}

export function parseE8AccountMetadata(value: unknown): E8AccountMetadata {
  const raw = rawObject(value);
  const maxLeverage = numberValue(raw.maxLeverage, raw.max_leverage, raw.leverage);
  const freeMargin = numberValue(raw.freeMargin, raw.free_margin);
  return {
    product: typeof raw.product === "string" ? raw.product : typeof raw.accountType === "string" ? raw.accountType : undefined,
    platform: typeof raw.platform === "string" ? raw.platform : typeof raw.exchange === "string" ? raw.exchange : undefined,
    marginMode: typeof raw.marginMode === "string" ? raw.marginMode : undefined,
    maxLeverage: Number.isFinite(maxLeverage) ? maxLeverage : undefined,
    freeMargin: Number.isFinite(freeMargin) ? freeMargin : undefined,
    raw,
  };
}

export function parseE8InstrumentMetadata(value: unknown): E8InstrumentMetadata {
  const raw = rawObject(value);
  const minSize = numberValue(raw.minSize, raw.min_size);
  const tickSize = numberValue(raw.tickSize, raw.tick_size);
  const pricePrecision = numberValue(raw.pricePrecision, raw.price_precision);
  return {
    instrumentClass: typeof raw.class === "string" ? raw.class : undefined,
    quantityMode: explicitQuantityMode(raw),
    minSize: Number.isFinite(minSize) ? minSize : undefined,
    tickSize: Number.isFinite(tickSize) ? tickSize : undefined,
    pricePrecision: Number.isFinite(pricePrecision) ? pricePrecision : undefined,
    isMarketOpen: typeof raw.isMarketOpen === "boolean" ? raw.isMarketOpen : undefined,
    raw,
  };
}

export function summarizeE8Metadata(account: E8AccountMetadata, instrument: E8InstrumentMetadata): E8MetadataSummary {
  const accountProduct = account.product;
  const instrumentClass = instrument.instrumentClass;
  return {
    accountProduct,
    instrumentClass,
    quantityMode: instrument.quantityMode,
    status: accountProduct && instrumentClass && accountProduct.toLowerCase().includes("perpetual") && instrumentClass.toLowerCase() === "cfd"
      ? "mismatch"
      : accountProduct || instrumentClass ? "consistent" : "unknown",
  };
}

export function validateE8InstrumentMetadata(instrument: E8InstrumentMetadata): void {
  if (instrument.isMarketOpen !== true) throw new Error("E8 market is not confirmed open");
  if (instrument.quantityMode !== "size") throw new Error("E8 order amount unit is missing or ambiguous");
  if (typeof instrument.minSize !== "number" || !Number.isFinite(instrument.minSize) || instrument.minSize <= 0) {
    throw new Error("E8 instrument minSize is missing or invalid");
  }
  if (typeof instrument.tickSize !== "number" || !Number.isFinite(instrument.tickSize) || instrument.tickSize <= 0) {
    throw new Error("E8 instrument tickSize is missing or invalid");
  }
  if (typeof instrument.pricePrecision !== "number" || !Number.isInteger(instrument.pricePrecision) || instrument.pricePrecision < 0) {
    throw new Error("E8 instrument pricePrecision is missing or invalid");
  }
}

function validateNativeAmount(amount: number, instrument: E8InstrumentMetadata, unit: QuantityMode | undefined): void {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("E8 order amount must be positive and finite");
  validateE8InstrumentMetadata(instrument);
  if (unit !== "size") throw new Error("E8 order amount unit is missing or ambiguous");
  if (amount < instrument.minSize!) throw new Error(`E8 order amount ${amount} is below minSize ${instrument.minSize}`);
}

function parsePosition(value: unknown): ProprPosition | null {
  const item = objectValue(value);
  const quantity = numberValue(item.quantity, item.size, item.amount);
  const markPrice = numberValue(item.markPrice, item.mark_price, item.price);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(markPrice)) return null;
  const side = String(item.positionSide ?? item.side ?? "").toLowerCase();
  return {
    positionId: typeof item.positionId === "string" ? item.positionId : undefined,
    asset: typeof item.symbol === "string" ? item.symbol : undefined,
    positionSide: side.includes("short") || side === "sell" ? "short" : "long",
    quantity: String(quantity),
    markPrice: String(markPrice),
  };
}

export class E8Client implements ProprClient {
  private accountId: string | null = null;

  constructor(
    private readonly dryRun = true,
    private readonly apiKey = process.env.E8_API_KEY,
    private readonly baseUrl = process.env.E8_API_URL ?? "https://trade.e8markets.com/api/mcp",
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    if (!apiKey?.trim()) throw new Error("E8_API_KEY is required");
    if (!/^e8_[A-Za-z0-9_-]+$/.test(apiKey.trim())) throw new Error("E8_API_KEY must be a valid e8_ API key");
    this.apiKey = apiKey.trim();
  }

  private async call<T>(name: string, argumentsValue: JsonObject, method = "tools/call"): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey!}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ulid(),
        method,
        ...(method === "tools/call" ? { params: { name, arguments: argumentsValue } } : { params: argumentsValue }),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json() as JsonObject;
    if (!response.ok) {
      const detail = payload.message ?? payload.error ?? payload;
      const message = typeof detail === "string" ? detail : JSON.stringify(detail);
      throw new Error(`E8 API ${response.status}: ${message}`);
    }
    if (payload.error) throw new Error(`E8 tool ${name}: ${String(objectValue(payload.error).message ?? "request failed")}`);
    return parseToolText(payload.result) as T;
  }

  async health(): Promise<{ status: string }> {
    await this.call("e8_accounts_list", {});
    return { status: "OK" };
  }

  async getUser(): Promise<unknown> { return this.call("e8_accounts_list", {}); }

  async setup(accountId?: string): Promise<string> {
    if (!accountId) throw new Error("E8 accountId is required");
    this.accountId = accountId;
    return accountId;
  }

  async listAssets(search: string, assetClass: E8AssetClass, limit: number): Promise<unknown[]> {
    if (!search.trim()) throw new Error("E8 asset search is required");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("E8 asset limit must be an integer from 1 to 100");
    const catalog = await this.call<unknown>("tools/list", {}, "tools/list");
    if (!toolNames(catalog).has("e8_trade_asset_list")) throw new Error("E8 tool e8_trade_asset_list is unavailable");
    return arrayValue(await this.call("e8_trade_asset_list", { search, assetClass, limit }));
  }

  async refreshAccountSnapshot(): Promise<AccountSnapshot> {
    const value = objectValue(await this.call("e8_account_info", { accountId: this.accountId }));
    const balance = numberValue(value.balance, value.startingBalance);
    const equity = numberValue(value.equity, value.accountEquity, balance);
    if (![balance, equity].every(Number.isFinite)) throw new Error("E8 account response lacks numeric balance/equity");
    const accountMetadata = parseE8AccountMetadata(value);
    return {
      balance,
      equity,
      accountId: this.accountId ?? undefined,
      platform: "e8",
      accountProduct: accountMetadata.product,
      accountMetadata,
      metadataStatus: accountMetadata.product ? "consistent" : "unknown",
    };
  }

  private async instrumentMetadata(symbol: string): Promise<E8InstrumentMetadata> {
    return parseE8InstrumentMetadata(await this.call("e8_trade_asset_get", { symbol }));
  }

  async getPositions(symbol?: string): Promise<ProprPosition[]> {
    const value = await this.call("e8_positions_list", { accountId: this.accountId, ...(symbol ? { symbol } : {}) });
    return arrayValue(value).map(parsePosition).filter((position): position is ProprPosition => position !== null);
  }

  async hasPendingOrders(symbol: string): Promise<boolean> {
    const value = await this.call("e8_orders_list", { accountId: this.accountId, status: "PENDING", symbol });
    return arrayValue(value).length > 0;
  }

  async setLeverage(_symbol: string, _leverage: number): Promise<void> {
    // E8 applies instrument/account leverage server-side; no documented setter exists.
  }

  async fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const resolution = interval === "1m" ? "1" : interval.endsWith("m") ? interval.slice(0, -1) : interval;
    const value = await this.call("e8_trade_history", { symbol, resolution, countBack: limit });
    const candles = arrayValue(value).map((raw) => {
      const item = objectValue(raw);
      return {
        timestamp: numberValue(item.timestamp, item.time, item.t),
        open: numberValue(item.open, item.o),
        high: numberValue(item.high, item.h),
        low: numberValue(item.low, item.l),
        close: numberValue(item.close, item.c),
        volume: numberValue(item.volume, item.v),
      } satisfies Candle;
    }).filter((candle) => [candle.timestamp, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));
    if (candles.length < 21) throw new Error(`E8 returned only ${candles.length} candles`);
    return candles.slice(-limit);
  }

  async submit_trade(request: TradeRequest): Promise<AccountSnapshot> {
    if (this.dryRun) return this.refreshAccountSnapshot();
    if (request.closePosition) {
      await this.call("e8_position_close", { accountId: this.accountId, symbol: request.symbol });
    } else {
      const instrument = await this.instrumentMetadata(request.symbol);
      validateNativeAmount(request.size, instrument, request.sizeUnit);
      await this.call("e8_order_place", {
        accountId: this.accountId,
        symbol: request.symbol,
        side: request.side === "long" ? "buy" : "sell",
        amount: request.size,
        type: "market",
        clientOrderId: ulid(),
      });
    }
    return this.refreshAccountSnapshot();
  }

  async submitProtectedTrade(request: ProtectedTradeRequest): Promise<OneShotOrderResult[]> {
    if (this.dryRun) throw new Error("Protected live trade requires DRY_RUN=false");
    const instrument = await this.instrumentMetadata(request.symbol);
    validateNativeAmount(request.quantity, instrument, request.quantityUnit);
    const result = await this.call<JsonObject>("e8_order_place", {
      accountId: this.accountId,
      symbol: request.symbol,
      side: request.side === "long" ? "buy" : "sell",
      amount: request.quantity,
      type: "market",
      stopLoss: request.stopLossPrice,
      takeProfit: request.takeProfitPrice,
      clientOrderId: ulid(),
    });
    const order = objectValue(result);
    return [{
      orderId: typeof order.orderId === "string" ? order.orderId : undefined,
      status: typeof order.status === "string" ? order.status : undefined,
      type: "market",
    }];
  }

  async submitOneShotShort(request: OneShotShortRequest): Promise<OneShotOrderResult[]> {
    return this.submitProtectedTrade({ ...request, side: "short" });
  }
}
