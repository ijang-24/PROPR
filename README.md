# Propr market pipeline

Pipeline modular untuk membaca candle, menghitung EMA9/EMA21 dengan konfirmasi support/resistance, menjalankan risk lock, dan mengirim protected trade melalui adapter Propr.

Mode default `DRY_RUN=true`. Set ke `false` hanya setelah adapter SDK resmi diisi dan diuji pada sandbox/testnet.

## Jalankan

```powershell
npm install
Copy-Item .env.example .env
npm run check
npm test
npm run dev
```

Adapter memakai kontrak REST yang didokumentasikan di `XBorgLabs/propr-docs`: health, user, challenge, account, positions, dan orders. Untuk `XYZ100-USDC`, adapter mengirim `asset: xyz:XYZ100`, `base: XYZ100`, `quote: USDC`. Karena Propr tidak menyediakan candle endpoint, pipeline mengambil candle `1m` yang sudah selesai dari Hyperliquid Info API publik (`candleSnapshot`), lalu memakai EMA9/EMA21 dan zona support/resistance. Polling tetap 1 detik; Hyperliquid tidak mendukung candle `1s`. Detail lokal ada di `.claude/skills/docs-propr/SKILL.md`.

## Kontrak adapter

`fetchCandles(symbol, interval, limit)` mengembalikan candle OHLC numerik terbaru.

`submit_trade({ side, symbol, size })` memetakan `long` ke order `buy` + `positionSide: long` dan `short` ke `sell` + `positionSide: short`, memakai `asset` HIP-3 yang benar, serta menolak response order kosong/rejected. Entry memerlukan dua konfirmasi: EMA9/EMA21 dan harga berada di zona support (LONG) atau resistance (SHORT). Setelah posisi flat, entry baru diblokir selama 5 menit. `DRY_RUN=true` default; mode live hanya mengirim order saat `DRY_RUN=false`.

## Operasional

Risk engine fail-closed: file accounts invalid atau loss mencapai batas akan melewati akun dan, bila state valid, menulis `locked: true`. API market insight dashboard hanya menampilkan candle terverifikasi; simbol tanpa feed ditandai unavailable, bukan diberi harga sintetis.
