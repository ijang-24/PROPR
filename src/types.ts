export type Platform = "propr" | "e8";
export type AccountType = "funded" | "challenge";
export type Side = "long" | "short";
export type Position = "NONE" | "LONG" | "SHORT";
export type Classification = "UP" | "DOWN" | "CLOSE" | "HOLD";
export type QuantityMode = "lots" | "contracts" | "size" | "unknown";
export type MetadataStatus = "consistent" | "mismatch" | "unknown";

export interface E8AccountMetadata {
  product?: string;
  platform?: string;
  marginMode?: string;
  maxLeverage?: number;
  freeMargin?: number;
  raw: Record<string, unknown>;
}

export interface E8InstrumentMetadata {
  instrumentClass?: string;
  quantityMode: QuantityMode;
  minSize?: number;
  tickSize?: number;
  pricePrecision?: number;
  isMarketOpen?: boolean;
  raw: Record<string, unknown>;
}

export interface E8MetadataSummary {
  accountProduct?: string;
  instrumentClass?: string;
  quantityMode: QuantityMode;
  status: MetadataStatus;
}

export interface TradingAccount {
  accountId: string;
  platform: Platform;
}

export interface QueueState {
  nextAccountIndex: number;
  lastEntryAt?: number;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface AccountState {
  initial_balance: number;
  balance: number;
  equity: number;
  max_daily_loss: number;
  accountId?: string;
  platform?: Platform;
  accountType?: AccountType;
  accountProduct?: string;
  instrumentClass?: string;
  metadataStatus?: MetadataStatus;
  accountMetadata?: E8AccountMetadata;
  instrumentMetadata?: E8InstrumentMetadata;
  locked?: boolean;
  updated_at?: string | null;
}

export interface TradeRequest {
  side: Side;
  symbol: string;
  size: number;
  sizeUnit?: QuantityMode;
  positionSide?: "long" | "short";
  closePosition?: boolean;
}

export interface ProtectedTradeRequest {
  side: Side;
  symbol: string;
  quantity: number;
  quantityUnit?: QuantityMode;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}

export type OneShotShortRequest = Omit<ProtectedTradeRequest, "side">;

export interface OneShotOrderResult {
  orderId?: string;
  status?: string;
  type?: string;
}

export interface ProprPosition {
  positionId?: string;
  asset?: string;
  base?: string;
  quote?: string;
  positionSide?: string;
  status?: string;
  quantity: string;
  markPrice: string;
}

export interface AccountSnapshot {
  balance: number;
  equity: number;
  accountId?: string;
  platform?: Platform;
  accountType?: AccountType;
  accountProduct?: string;
  instrumentClass?: string;
  metadataStatus?: MetadataStatus;
  accountMetadata?: E8AccountMetadata;
  instrumentMetadata?: E8InstrumentMetadata;
}

export type E8AssetClass = "forex" | "stocks" | "futures" | "cfd";

export interface ProprClient {
  health(): Promise<{ status: string }>;
  getUser(): Promise<unknown>;
  setup(accountId?: string): Promise<string>;
  refreshAccountSnapshot(): Promise<AccountSnapshot>;
  listAssets?(search: string, assetClass: E8AssetClass, limit: number): Promise<unknown[]>;
  getPositions(symbol?: string): Promise<ProprPosition[]>;
  hasPendingOrders(symbol: string): Promise<boolean>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  submit_trade(request: TradeRequest): Promise<AccountSnapshot>;
  submitProtectedTrade(request: ProtectedTradeRequest): Promise<OneShotOrderResult[]>;
  submitOneShotShort(request: OneShotShortRequest): Promise<OneShotOrderResult[]>;
}
