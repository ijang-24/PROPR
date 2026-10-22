# Propr market pipeline

Pipeline modular untuk membaca candle, mengirim payload numerik ke OpenCode CLI, memvalidasi classification, menjalankan risk lock, dan mengirim trade melalui adapter Propr.

Mode default `DRY_RUN=true`. Set ke `false` hanya setelah adapter SDK resmi diisi dan diuji pada sandbox/testnet.

## Jalankan

```powershell
npm install
Copy-Item .env.example .env
npm run check
npm test
npm run dev
```

Adapter memakai kontrak REST yang didokumentasikan di `XBorgLabs/propr-docs`: `GET /health`, `GET /users/me`, `GET /challenge-attempts`, `GET /accounts/{accountId}`, dan `POST /accounts/{accountId}/orders` dengan ULID order market. Dokumentasi resmi tidak menyediakan endpoint candle/klines, sehingga `fetchCandles()` fail-closed dan tidak mengarang endpoint.

## Kontrak adapter

`fetchCandles(symbol, interval, limit)` mengembalikan candle OHLC numerik terbaru.

`submit_trade({ side, symbol, size })` memetakan `long` ke order `buy` + `positionSide: long` dan `short` ke `sell` + `positionSide: short`, lalu menyegarkan snapshot akun. `DRY_RUN=true` default; mode live hanya mengirim order saat `DRY_RUN=false`.

## Operasional

Risk engine fail-closed: file accounts invalid, angka tidak finite, atau loss mencapai batas akan menghentikan loop dan menulis `locked: true`. OpenCode dipanggil tanpa shell interpolation menggunakan `spawn`, dan output harus JSON tunggal dengan classification `UP`, `DOWN`, atau `HOLD`.
