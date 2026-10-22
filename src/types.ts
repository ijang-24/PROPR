export type Side = "long" | "short";
export type Classification = "UP" | "DOWN" | "HOLD";

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
  fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  submit_trade(request: TradeRequest): Promise<AccountSnapshot>;
}
