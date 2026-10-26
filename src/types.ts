export type Platform = "propr" | "e8";
export type AccountType = "funded" | "challenge";
export type Side = "long" | "short";
export type Position = "NONE" | "LONG" | "SHORT";
export type Classification = "UP" | "DOWN" | "CLOSE" | "HOLD";
export type QuantityMode = "lots" | "contracts" | "size" | "unknown";
export type MetadataStatus = "consistent" | "mismatch" | "unknown";
export type AccountRole = "master" | "follower";
export type OrderStatus = "pending" | "open" | "partially_filled" | "filled" | "cancelled" | "expired" | "rejected";

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
  role: AccountRole;
}

export interface ProprOrder {
  orderId?: string;
  intentId?: string;
  orderGroupId?: string | null;
  positionId?: string | null;
  status?: OrderStatus | string;
  type?: string;
  side?: string;
  positionSide?: string;
  asset?: string;
  base?: string;
  quantity?: string;
  triggerPrice?: string;
  reduceOnly?: boolean;
  closePosition?: boolean;
}

export interface ProprOrderResponse {
  data?: ProprOrder[];
}

export type CooldownReason = "sl" | "tp" | "unknown";

export interface CopyState {
  lastMasterPosition: Position;
  lastMasterCloseAt?: number;
  lastMasterCloseReason?: CooldownReason;
}

export interface CopyAction {
  kind: "close" | "open";
  side: Side;
}

export interface ProprClientOrderSupport {
  listOrders(symbol: string): Promise<ProprOrder[]>;
  cancelOrder(orderId: string): Promise<void>;
}

export const PROPR_COOLDOWN_MS = 5 * 60_000;

export function positionToSide(position: Position): Side | null {
  if (position === "LONG") return "long";
  if (position === "SHORT") return "short";
  return null;
}

export function planPositionTransition(target: Position, current: Position): CopyAction[] {
  if (target === current) return [];
  const targetSide = positionToSide(target);
  const currentSide = positionToSide(current);
  const actions: CopyAction[] = [];
  if (currentSide) actions.push({ kind: "close", side: currentSide });
  if (targetSide) actions.push({ kind: "open", side: targetSide });
  return actions;
}

export function cooldownRemaining(lastCloseAt: number | undefined, now = Date.now()): number {
  if (!lastCloseAt || !Number.isFinite(lastCloseAt)) return 0;
  return Math.max(0, PROPR_COOLDOWN_MS - (now - lastCloseAt));
}

export function cooldownUntilRemaining(cooldownUntil: number | undefined, now = Date.now()): number {
  if (!cooldownUntil || !Number.isFinite(cooldownUntil)) return 0;
  return Math.max(0, cooldownUntil - now);
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
  stateSymbol?: string;
  platform?: Platform;
  accountType?: AccountType;
  accountProduct?: string;
  instrumentClass?: string;
  metadataStatus?: MetadataStatus;
  accountMetadata?: E8AccountMetadata;
  instrumentMetadata?: E8InstrumentMetadata;
  locked?: boolean;
  observedPosition?: Position;
  cooldownUntil?: number;
  cooldownReason?: CooldownReason;
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
  listOrders?(symbol: string): Promise<ProprOrder[]>;
  cancelOrder?(orderId: string): Promise<void>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  submit_trade(request: TradeRequest): Promise<AccountSnapshot>;
  submitProtectedTrade(request: ProtectedTradeRequest): Promise<OneShotOrderResult[]>;
  submitOneShotShort(request: OneShotShortRequest): Promise<OneShotOrderResult[]>;
}
