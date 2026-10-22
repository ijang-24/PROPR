export type Side = "long" | "short";
export type Position = "NONE" | "LONG" | "SHORT";
export type Classification = "UP" | "DOWN" | "CLOSE" | "HOLD";

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
  locked?: boolean;
  updated_at?: string | null;
}

export interface TradeRequest {
  side: Side;
  symbol: string;
  size: number;
  positionSide?: "long" | "short";
  closePosition?: boolean;
}

export interface ProtectedTradeRequest {
  side: Side;
  symbol: string;
  quantity: number;
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
}

export interface ProprClient {
  health(): Promise<{ status: string }>;
  getUser(): Promise<unknown>;
  setup(accountId?: string): Promise<string>;
  refreshAccountSnapshot(): Promise<AccountSnapshot>;
  getPositions(symbol?: string): Promise<ProprPosition[]>;
  hasPendingOrders(symbol: string): Promise<boolean>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  submit_trade(request: TradeRequest): Promise<AccountSnapshot>;
  submitProtectedTrade(request: ProtectedTradeRequest): Promise<OneShotOrderResult[]>;
  submitOneShotShort(request: OneShotShortRequest): Promise<OneShotOrderResult[]>;
}
