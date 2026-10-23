---
name: docs-e8
description: Official E8 Markets MCP reference for accounts, market data, positions, orders, authentication, and automation limits.
---

# E8 Markets API Reference

Official docs:

- Overview: https://trade.e8markets.com/docs/index.html
- MCP connection: https://trade.e8markets.com/docs/mcp/01_connect.html
- Tool reference: https://trade.e8markets.com/docs/mcp/02_tool_reference.html
- Safety and limits: https://trade.e8markets.com/docs/mcp/05_safety_and_limits.html
- Agent skill: https://trade.e8markets.com/docs/mcp/06_agent_skill.html

## Transport and authentication

E8 documents an MCP JSON-RPC endpoint, not a generic REST order API:

```text
https://trade.e8markets.com/api/mcp
```

Every request uses:

```http
Authorization: Bearer <E8_API_KEY>
Content-Type: application/json
Accept: application/json, text/event-stream
```

The key must stay in `.env` or a secret manager. Keys with `trade:execute` can place, cancel, and close real orders. Read-only keys should omit that scope.

## JSON-RPC calls

Use `tools/list` to discover the live tool catalog. Use `tools/call` with:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "e8_accounts_list",
    "arguments": {}
  }
}
```

Tool names and schemas are authoritative at runtime; docs state the catalog can change.

## Account and market tools

- `e8_accounts_list`: accounts.
- `e8_account_info`: balance, equity, margin; pass `accountId` when multiple accounts exist.
- `e8_positions_list`: open positions.
- `e8_orders_list`: order history/pending orders.
- `e8_account_limits`: daily-loss and drawdown headroom.
- `e8_trade_asset_get`: market-open state, price precision, minimum size, tick size.
- `e8_trade_asset_list`: runtime-dependent asset discovery; pass the exact search, asset class, and limit accepted by the live schema.
- `e8_trade_history`: OHLCV history for local indicator calculations.

The live `tools/list` catalog is authoritative. If `e8_trade_asset_list` is absent, report unsupported rather than treating it as an empty catalog. If it returns an empty list, preserve that result; do not invent aliases such as `XAUUSD`, `GOLD`, or HIP-3-prefixed symbols.

The pipeline computes EMA locally. E8 does not provide indicator tools.

## Execution tools

Required scope: `trade:execute`.

- `e8_order_place`: market/limit/stop order with `symbol`, `side`, `amount`, optional `stopLoss`, `takeProfit`, and `clientOrderId`.
- `e8_position_close`: close one position.
- `e8_positions_close_all`: close all positions.
- `e8_order_cancel`: cancel a pending order.

E8 documents `amount` as lots, not units. Read `minSize` and `tickSize`; never blindly convert a unit quantity to lots. This project adapter passes its calculated quantity as `amount` and should be validated against the target E8 instrument before live use.

## Automation constraints

- Resolve and pass `accountId`; omitting it fails when multiple accounts exist.
- Check market-open status before market orders.
- Use deterministic `clientOrderId` for retry safety.
- Respect `429` and `Retry-After`.
- Never place, cancel, or close an order without explicit authorization for that action.
- Never log API keys.

## Project adapter mapping

`src/adapters/e8-client.ts` uses the documented MCP endpoint and maps:

- account info → `e8_account_info`
- positions → `e8_positions_list`
- pending orders → `e8_orders_list`
- candles → `e8_trade_history`
- entry with TP/SL → `e8_order_place`
- close → `e8_position_close`

The live E8 response shape can vary with the current tool catalog. The adapter keeps parsing defensive and fails closed when required numeric fields are absent.
