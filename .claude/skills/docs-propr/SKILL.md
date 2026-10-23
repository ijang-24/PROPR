---
name: docs-propr
description: Referensi lokal API Propr untuk endpoint akun, posisi, order, symbol Hyperliquid, WebSocket, dan batasan market data.
---

# Propr API Reference

Sumber resmi:

- REST/OpenAPI: `https://propr.xyz/openapi.json`
- API docs: `https://github.com/XBorgLabs/propr-docs/blob/main/docs/api.md`
- WebSocket docs: `https://github.com/XBorgLabs/propr-docs/blob/main/docs/websocket.md`

## Base URL dan auth

- Production REST: `https://api.propr.xyz/v1`
- Beta REST: `https://api.beta.propr.xyz/v1`
- Production WebSocket: `wss://api.propr.xyz/ws`
- Header API key: `X-API-Key: pk_live_...`
- Rate limit: 1,200 request/menit.
- API key punya akses penuh; simpan hanya di `.env`.

## Endpoint yang relevan

- `GET /health`
- `GET /users/me`
- `GET /challenge-attempts?status=active`
- `GET /accounts/{accountId}`
- `GET /accounts/{accountId}/positions`
- `GET /accounts/{accountId}/orders`
- `GET /accounts/{accountId}/trades`
- `POST /accounts/{accountId}/orders`

Response paginated umumnya memakai `{ data: [...] }`. Nilai uang dan harga dikembalikan sebagai string desimal.

## Symbol

Order memakai asset ticker, bukan pair:

```json
{
  "asset": "BTC",
  "base": "BTC",
  "quote": "USDC"
}
```

Pair seperti `BTC/USDC` atau `XYZ100-USDC` tidak boleh dikirim sebagai `asset` mentah.

HIP-3 memakai prefix `xyz:`. Docs memberi contoh `xyz:AAPL`, `xyz:GOLD`, dan indeks XYZ100 disebut sebagai pasar yang didukung, tetapi daftar OpenAPI tidak memuat endpoint market-universe atau candle untuk memvalidasi ticker persisnya. Konfirmasi identifier XYZ100 dari dashboard/endpoint order sebelum live.

## Posisi dan harga

`GET /accounts/{accountId}/positions` mengembalikan `markPrice`, `entryPrice`, dan `quantity`. Filter posisi aktif dengan `status=open` serta `quantity != "0"`.

`markPrice` adalah harga snapshot posisi, bukan historical OHLC. Docs memperingatkan REST `markPrice` dapat stale; WebSocket `position.updated` lebih tepat untuk update posisi live.

Jika tidak ada posisi aktif, endpoint posisi tidak menyediakan harga market yang dapat dipakai sebagai ticker umum.

## RSI dan candle

Propr API/OpenAPI yang terdokumentasi tidak menyediakan endpoint candle/klines, ticker umum, atau historical close series. RSI bukan field API. RSI harus dihitung lokal dari minimal 15 close prices aktual.

Karena itu:

- RSI chart `53.82` tidak otomatis tersedia di API Propr.
- Simulator pipeline menghasilkan RSI simulasi, bukan RSI chart.
- `markPrice` satu titik tidak cukup menghitung RSI.
- WebSocket Propr mendokumentasikan event akun/order/position/trade, bukan OHLC candle stream.

Jangan mengarang endpoint `/candles`, `/klines`, atau `/ticker` Propr. Gunakan Hyperliquid Info API publik `POST https://api.hyperliquid.xyz/info` dengan body `{"type":"candleSnapshot","req":{"coin":"xyz:XYZ100","interval":"1m","startTime":...,"endTime":...}}`, lalu konversi close series ke `Candle[]`. Hyperliquid tidak mendukung interval `1s`; polling pipeline boleh 1 detik, candle minimal `1m`.

## Order dan TP/SL

Create order memakai body `{ "orders": [...] }`, `intentId` ULID unik, `type`, `side`, `positionSide`, `asset`, `base`, `quote`, dan `quantity` sebagai string.

Market entry:

```json
{
  "type": "market",
  "timeInForce": "IOC",
  "side": "buy",
  "positionSide": "long",
  "reduceOnly": false,
  "closePosition": false
}
```

SL/TP memakai order conditional terpisah dengan `triggerPrice`, bukan field `takeProfit`/`stopLoss` pada market order:

- SL: `type=stop_market`
- TP: `type=take_profit_market`
- Keduanya `reduceOnly=true`
- Sertakan `positionId` setelah entry terisi, atau kirim dalam group entry yang valid.

Closing wajib memakai `reduceOnly=true`; full close juga `closePosition=true`.

## WebSocket

Connect dengan `X-API-Key`. Event terdokumentasi:

- `position.updated`
- `position.opened`
- `position.closed`
- `order.filled`
- `trade.created`
- account/order events lainnya

Tidak ada event candle/ticker yang terdokumentasi. Jangan memakai WebSocket event posisi sebagai pengganti historical close series.

## Strategi pipeline saat ini

- Posisi `NONE` + RSI `<30`: entry LONG.
- Posisi `NONE` + RSI `>70`: entry SHORT.
- Posisi `LONG` + RSI `<=10` atau `>=60`: close LONG.
- Posisi `SHORT` + RSI `<=40` atau `>=90`: close SHORT.
- TP/SL dollar tidak dikirim; exit berasal dari sinyal RSI dan memakai market order `reduceOnly`/`closePosition`.

## Guardrails implementasi

1. `DRY_RUN=true` tetap default.
2. Fail-closed jika candle aktual belum tersedia.
3. Validasi symbol sebelum live order.
4. Jangan log API key.
5. Gunakan decimal strings untuk payload harga/uang; hindari float untuk serialisasi order.
6. API key yang pernah terekspos harus di-rotate dari Settings Propr.
