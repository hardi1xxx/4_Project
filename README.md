# Dashboard Monitoring (MBB, OLO, HEM, FBB, PT2)

Aplikasi web untuk monitoring atasan, menarik data **live** dari Google Sheets,
dengan fitur pencarian dan filter per kolom.

## ⚠️ Syarat Penting: Spreadsheet harus bisa diakses publik

Aplikasi ini mengambil data lewat endpoint CSV publik Google Sheets
(`/gviz/tq?tqx=out:csv`). Ini **hanya berfungsi jika sheet dibagikan sebagai**:

> Share → General access → **Anyone with the link → Viewer**

Kalau spreadsheet harus tetap privat (tidak bisa di-share publik), beri tahu saya
nanti supaya saya ubahkan ke metode **Google Service Account + Sheets API**
(lebih aman, tidak perlu publik, tapi butuh setup credential JSON).

## Struktur Proyek

```
monitoring-app/
├── server.js          # Backend Express - ambil data dari Google Sheets, API search/filter
├── public/
│   └── index.html      # Frontend dashboard (tab per sheet, search, filter)
├── package.json
├── railway.json
└── .gitignore
```

## Menjalankan di Lokal

```bash
cd monitoring-app
npm install
npm start
```

Buka di browser: http://localhost:3000

## Konfigurasi

ID spreadsheet sudah di-hardcode di `server.js` sesuai link yang diberikan:
```
1MqKFY3mn7-Qa2xn9kslKPKYCF15ONWPf71_dZuIF458
```
Bisa juga di-override lewat environment variable `SHEET_ID` di Railway, tanpa
perlu ubah kode.

Daftar tab yang dimonitor: `MBB, OLO, HEM, FBB, PT2` (di `server.js`, variabel
`SHEET_NAMES`). Tambah/kurangi sesuai kebutuhan.

## Deploy ke Railway

### Opsi A — Lewat GitHub (disarankan)
1. Push folder ini ke repo GitHub baru.
2. Buka https://railway.app → **New Project** → **Deploy from GitHub repo**.
3. Pilih repo tadi. Railway otomatis mendeteksi Node.js (Nixpacks) dan menjalankan `npm install` + `npm start`.
4. Setelah deploy selesai, klik **Generate Domain** di tab **Settings → Networking** untuk dapat URL publik (`*.up.railway.app`).
5. (Opsional) Set environment variable `SHEET_ID` di tab **Variables** kalau ID sheet berubah.

### Opsi B — Lewat Railway CLI
```bash
npm install -g @railway/cli
railway login
cd monitoring-app
railway init
railway up
railway domain   # generate domain publik
```

## Fitur

- **Tema terang** dengan 3 logo brand di header: Telkom Akses, Danantara Indonesia, Infranexia.
- **5 tab sheet**: MBB, OLO, HEM, FBB, PT2 — klik tab untuk ganti data.
- **Kartu angka besar** status pekerjaan per sheet (total + breakdown per status).
- **Grafik bar & donut** untuk visualisasi proporsi status, otomatis update sesuai sheet aktif.
- **Pencarian global**: cari teks di semua kolom sekaligus.
- **Filter per kolom**: tambah filter dropdown untuk kolom tertentu, bisa lebih dari satu filter sekaligus.
- **Auto refresh**: data di-cache 60 detik di server, dan frontend auto-reload tiap 60 detik. Tombol "🔄 Refresh Data" untuk paksa ambil data terbaru.
- **Responsive table**: scroll horizontal/vertikal, header sticky.

## Kolom Status yang Dipakai untuk Kartu & Grafik

Diset di `server.js` pada variabel `STATUS_COLUMN`:

| Sheet | Kolom Status |
|---|---|
| MBB | `Status Pekerjaan` |
| OLO | `STATUS PEKERJAAN` |
| FBB | `Status Fisik` |
| HEM | `PROGRESS JT LAST UPDATE` |
| PT2 | `STATUS LOP` |

Kalau nama kolom di spreadsheet berbeda penulisannya (typo/spasi), update nilai di `STATUS_COLUMN` agar kartu & grafik bisa baca datanya dengan benar.

## Endpoint API (kalau ingin diintegrasikan ke tempat lain)

| Endpoint | Keterangan |
|---|---|
| `GET /api/sheets` | Daftar nama sheet |
| `GET /api/data/:sheet?search=...&filter_KolomX=NilaiY` | Data sheet + search + filter |
| `GET /api/options/:sheet/:column` | Daftar nilai unik suatu kolom (untuk dropdown filter) |
| `GET /api/summary` | Ringkasan jumlah baris tiap sheet |
| `GET /health` | Health check |

## Troubleshooting

- **Error "tidak bisa diakses publik"**: ubah sharing setting spreadsheet ke "Anyone with the link can view".
- **Nama kolom aneh/kosong**: pastikan baris pertama tiap sheet adalah header (nama kolom), tanpa baris judul/merge cell di atasnya.
- **Data tidak update**: klik "🔄 Refresh Data" untuk bypass cache 60 detik.
