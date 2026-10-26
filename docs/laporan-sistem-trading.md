# Laporan Sistem Trading Otomatis

**Dokumen untuk client**  
**Tanggal:** 26 Oktober 2026  
**Status:** Deskripsi teknis berdasarkan implementasi repository saat laporan dibuat

> **Disclaimer:** Dokumen ini menjelaskan cara kerja perangkat lunak. Dokumen ini bukan jaminan profit, bukan nasihat investasi, dan bukan jaminan bahwa order akan terisi pada harga tertentu. Hasil aktual dipengaruhi oleh likuiditas, slippage, latency, kondisi akun, batas platform, dan kegagalan jaringan.

## 1. Ringkasan eksekutif

Sistem ini adalah pipeline copy-trading untuk akun Propr dengan satu akun **master** dan satu atau lebih akun **follower**. Pipeline membaca data candle dari Hyperliquid, menghitung arah tren menggunakan EMA9 dan EMA21, memeriksa risiko serta status posisi, lalu menyelaraskan posisi master dan follower melalui adapter Propr.

Dashboard Next.js berfungsi sebagai monitor state akun lokal dan snapshot market. Dashboard tidak menjadi sumber eksekusi order dan tidak menghapus posisi atau order remote ketika state lokal dihapus.

Implementasi aktif menggunakan strategi EMA9/EMA21. Support/resistance tidak menjadi filter entry pada runtime saat ini; referensi lama yang menyebut support/resistance harus dianggap dokumentasi yang belum sinkron dengan kode aktif.

## 2. Komponen sistem

```text
Hyperliquid candleSnapshot (1m)
              │
              ▼
       Pipeline TypeScript
       ├─ EMA9 / EMA21
       ├─ risk lock
       ├─ cooldown 5 menit
       ├─ pending-order check
       └─ position synchronization
              │
              ▼
        Propr REST API
       ├─ account snapshot
       ├─ positions
       └─ market + TP/SL orders
              │
              ▼
     Local account state (.accounts)
              │
              ▼
       Next.js dashboard
```

Komponen utama:

- **Pipeline:** menjalankan loop sinkronisasi dan mengatur urutan master/follower.
- **Market data adapter:** mengambil candle dari Hyperliquid Info API publik.
- **Propr adapter:** membaca akun/posisi/order dan mengirim order ketika mode live aktif.
- **Risk engine:** mengevaluasi equity, loss, dan status lock per akun.
- **Local state:** menyimpan snapshot akun, posisi yang diamati, dan cooldown.
- **Dashboard:** menampilkan akun, risiko, posisi, trade history yang tersedia, dan market snapshot.

Copy-trading aktif mensyaratkan tepat satu master dan registry akun Propr. Adapter E8 tersedia di repository, tetapi registry copy-trading aktif menolak akun non-Propr; E8 tidak termasuk dalam cakupan eksekusi copy-trading aktif.

## 3. Strategi sinyal aktual

### Indikator

Pipeline memakai dua exponential moving average:

- **EMA9:** EMA periode pendek, lebih responsif terhadap perubahan harga.
- **EMA21:** EMA periode lebih panjang, menjadi pembanding arah tren.

Data berasal dari candle `candleSnapshot` Hyperliquid dengan interval default `1m`. Pipeline meminta hingga 100 candle dan memerlukan sedikitnya 21 candle agar EMA21 dapat dihitung.

### Aturan posisi

| Kondisi | Tindakan sistem |
|---|---|
| Tidak ada posisi dan EMA9 > EMA21 | Target posisi LONG |
| Tidak ada posisi dan EMA9 < EMA21 | Target posisi SHORT |
| Posisi LONG dan EMA9 < EMA21 | Tutup posisi LONG |
| Posisi SHORT dan EMA9 > EMA21 | Tutup posisi SHORT |
| EMA9 = EMA21 atau arah tidak berubah | Pertahankan kondisi saat ini |

Perbandingan EMA dievaluasi ulang dalam setiap siklus. Sistem tidak mengklaim prediksi harga, win rate, atau profit tertentu.

### Support dan resistance

Support/resistance bukan gate aktif pada implementasi runtime saat ini. Sistem tidak boleh dipresentasikan sebagai strategi EMA + support/resistance sampai modul tersebut benar-benar diaktifkan dan diuji kembali.

## 4. Alur kerja end-to-end

1. Pipeline memuat registry akun dan memvalidasi satu master serta akun Propr.
2. Pipeline melakukan health check ke platform.
3. Pipeline mengambil candle market dari Hyperliquid.
4. EMA9 dan EMA21 dihitung dari seri close.
5. Pipeline membaca snapshot equity dan posisi master.
6. Risk lock, cooldown, posisi aktif, dan pending order diperiksa.
7. Jika target berbeda dari posisi sekarang, posisi lama ditutup terlebih dahulu.
8. Sistem menunggu konfirmasi posisi menjadi flat sebelum membuka sisi berlawanan.
9. Jika kondisi entry terpenuhi, sistem mengirim protected trade ke akun master.
10. Posisi master diverifikasi melalui pembacaan posisi.
11. Follower hanya disinkronkan jika master berhasil dikonfirmasi dan tidak sedang diblokir.
12. Snapshot akun dan state lokal diperbarui.
13. Dashboard membaca state lokal dan menampilkannya kepada operator.

Jika master gagal, diblokir risk lock, kekurangan balance, atau tidak mengonfirmasi target, follower tidak dianggap boleh membuka target baru.

## 5. Sistem TP dan SL

### Parameter

Take profit dan stop loss dikonfigurasi terpisah:

- `TARGET_PNL`: target nominal profit yang digunakan untuk menghitung jarak TP.
- `STOP_PNL`: batas nominal loss yang digunakan untuk menghitung jarak SL.

Nilai rahasia dari file `.env` tidak dicantumkan dalam dokumen ini. Untuk konfigurasi yang disetujui, TARGET_PNL ditetapkan USD 50 dan STOP_PNL USD 50; nilai aktual harus diverifikasi oleh operator pada environment yang akan digunakan.

### Rumus konseptual

```text
quantity = (equity × marginFraction × leverage) / entryPrice
TP distance = TARGET_PNL / quantity
SL distance = STOP_PNL / quantity
```

Untuk posisi LONG:

```text
TP price = entry price + TP distance
SL price = entry price - SL distance
```

Untuk posisi SHORT:

```text
TP price = entry price - TP distance
SL price = entry price + SL distance
```

Rumus tersebut menghasilkan **harga trigger berdasarkan quantity yang dihitung sistem**. Nominal realisasi dapat berbeda karena fill, slippage, fee, rounding, latency, dan perubahan equity.

### Bentuk order Propr

Pada jalur Propr live, sistem mengirim satu grup yang berisi:

1. market entry;
2. conditional `take_profit_market` dengan `reduceOnly=true`;
3. conditional `stop_market` dengan `reduceOnly=true`.

Saat sistem menutup posisi karena perubahan sinyal, sistem membatalkan pending order yang tersedia, mengirim market close dengan `reduceOnly` dan `closePosition`, lalu memeriksa posisi sampai flat.

Sistem tidak menjamin bahwa semua order terisi, tidak menjamin harga trigger tercapai tanpa slippage, dan tidak menjamin nominal PnL persis sama dengan parameter.

## 6. Cooldown setelah posisi flat

Setelah posisi terkonfirmasi flat, pipeline menyimpan waktu cooldown pada state akun dan menahan entry baru selama **5 menit**. Cooldown juga diterapkan ketika sistem mendeteksi posisi eksternal berubah dari aktif menjadi tidak ada, dengan pendekatan fail-safe ketika alasan close tidak tersedia.

```text
Posisi aktif
    │
    ├─ TP / SL / close terdeteksi
    ▼
Konfirmasi flat
    │
    ▼
Cooldown 5 menit
    │
    ▼
Sinyal baru dapat diproses
```

Master yang masih berada dalam cooldown dapat memblokir sinkronisasi follower. Tujuan cooldown adalah mengurangi risiko re-entry langsung setelah posisi keluar, bukan menjamin arah market berikutnya.

## 7. Risk management

Risk engine menghitung:

```text
loss = initial balance - current equity
```

Akun dianggap aman jika:

- state belum `locked`; dan
- `loss < max_daily_loss`.

Jika loss mencapai atau melewati `max_daily_loss`, sistem menulis `locked: true` dan melewati sinkronisasi akun tersebut. State invalid atau tidak dapat dibaca diperlakukan fail-closed.

Dashboard memiliki status visual `Safe`, `Warning`, dan `Violation`. Threshold visual dashboard dapat menggunakan fallback yang berbeda dari nilai `max_daily_loss` tersimpan; status risk engine tetap menjadi kontrol eksekusi utama.

Unlock dashboard hanya dapat mengubah state lokal ketika loss sudah kembali di bawah batas. Aksi remove account hanya mengubah registry/state lokal dan tidak menyentuh posisi atau order remote.

## 8. Dashboard dan market insight

Dashboard menampilkan:

- equity dan progress target;
- daily/max drawdown yang tersedia pada state;
- posisi saat ini;
- status risk;
- metadata akun;
- recent trade history yang tersedia;
- filter platform dan tipe akun;
- market snapshot.

Polling:

- state akun: setiap 3 detik;
- market insight: setiap 30 detik;
- market API cache: sekitar 30 detik.

Market insight menggunakan candle close 1m, bukan live tick. Feed yang diverifikasi di aplikasi mencakup `XYZ100` dan `GOLD` melalui Hyperliquid. `USDC` dan `USDJPY` ditampilkan sebagai tidak tersedia apabila tidak ada feed yang terverifikasi; aplikasi tidak membuat harga sintetis.

Dashboard API saat ini adalah monitor lokal dan belum menyediakan autentikasi/otorisasi berbasis user. Deployment di luar localhost memerlukan network isolation dan lapisan autentikasi tambahan.

## 9. Mode operasi

### Dry-run

`DRY_RUN=true` adalah default konfigurasi. Mode ini mencegah pengiriman order live, tetapi bukan simulasi offline penuh. Pipeline tetap membutuhkan API key, health check, akses market, dan pembacaan state remote. Jalur protected entry live tidak mengeksekusi fill simulasi.

### Live

`DRY_RUN=false` memungkinkan adapter mengirim order nyata ke Propr. Sebelum mengaktifkan live:

1. pastikan API key berada hanya di `.env` dan tidak masuk laporan/log;
2. verifikasi registry master/follower;
3. verifikasi `TARGET_PNL`, `STOP_PNL`, leverage, dan margin fraction;
4. pastikan pending order dan posisi remote dipahami;
5. uji dengan nominal dan environment yang disetujui;
6. siapkan monitoring dan prosedur penghentian.

Jangan menjalankan `test:one-shot` sebagai health check karena jalur tersebut dapat mengirim order live.

## 10. Risiko dan batasan operasional

- **Slippage dan fill:** harga sinyal bukan jaminan harga fill.
- **Leverage dan margin:** leverage memperbesar eksposur dan potensi loss.
- **Feed berbeda dari eksekusi:** sinyal berasal dari candle Hyperliquid, sedangkan posisi/order berasal dari Propr.
- **Polling:** loop dapat berjalan lebih cepat daripada pembentukan candle 1m.
- **Jaringan/API:** timeout, rate limit, response invalid, atau health failure dapat melewati satu siklus.
- **Reconciliation:** restart atau gangguan proses dapat memerlukan pemeriksaan ulang posisi/order remote.
- **Akses dashboard:** same-origin bukan pengganti autentikasi production.
- **Tidak ada jaminan hasil:** sistem tidak menjamin profit, win rate, fill, atau pencegahan liquidation.

## 11. Prosedur monitoring singkat

```powershell
npm run check
npm test
npm run dashboard:build
```

Untuk menjalankan dashboard saja:

```powershell
npm run dashboard:dev
```

Buka URL yang ditampilkan Next.js, biasanya `http://localhost:3000` atau port development yang tersedia. Untuk menjalankan pipeline, pastikan mode dan risiko sudah disetujui terlebih dahulu; jangan menjalankan `npm run dev` dengan `DRY_RUN=false` tanpa pengawasan.

## 12. Lampiran: evidence implementasi

Path berikut adalah referensi teknis internal untuk audit:

- `src/oscillator.ts` — EMA9/EMA21 dan klasifikasi arah.
- `src/pipeline.ts` — loop, sizing, entry/close, cooldown, master/follower.
- `src/config.ts` — pembacaan parameter environment.
- `src/types.ts` — tipe order, posisi, dan konstanta cooldown.
- `src/adapters/propr-client.ts` — REST account, position, dan order adapter.
- `src/adapters/hyperliquid-market-data.ts` — market candle adapter.
- `src/risk-engine.ts` — risk lock.
- `app/page.tsx` — dashboard monitor.
- `app/api/accounts/route.ts` — pembacaan state dashboard.
- `app/api/market-insight/route.ts` — market snapshot dashboard.
- `src/account-registry.ts` — validasi registry master/follower.

**Informasi yang sengaja tidak dicantumkan:** API key, nilai rahasia `.env`, payload autentikasi, dan account ID lengkap.
