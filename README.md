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

Adapter memakai kontrak REST yang didokumentasikan di `XBorgLabs/propr-docs`: health, user, challenge, account, positions, dan orders. Untuk `XYZ100-USDC`, adapter mengirim `asset: xyz:XYZ100`, `base: XYZ100`, `quote: USDC`. Karena Propr tidak menyediakan candle endpoint, pipeline mengambil candle `1m` dari Hyperliquid Info API publik (`candleSnapshot`) lalu menghitung RSI lokal. Polling tetap 1 detik; Hyperliquid tidak mendukung candle `1s`. Detail lokal ada di `.claude/skills/docs-propr/SKILL.md`.

## Kontrak adapter

`fetchCandles(symbol, interval, limit)` mengembalikan candle OHLC numerik terbaru.

`submit_trade({ side, symbol, size })` memetakan `long` ke order `buy` + `positionSide: long` dan `short` ke `sell` + `positionSide: short`, memakai `asset` HIP-3 yang benar, serta menolak response order kosong/rejected. Exit dikelola oleh threshold RSI: LONG keluar pada RSI <=10 atau >=60; SHORT keluar pada RSI <=40 atau >=90. `DRY_RUN=true` default; mode live hanya mengirim order saat `DRY_RUN=false`.

## Operasional

Risk engine fail-closed: file accounts invalid, angka tidak finite, atau loss mencapai batas akan menghentikan loop dan menulis `locked: true`. OpenCode dipanggil tanpa shell interpolation menggunakan `spawn`, dan output harus JSON tunggal dengan classification `UP`, `DOWN`, atau `HOLD`.
