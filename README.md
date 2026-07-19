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

## ✏️ Fitur Update Data dari Web (tulis balik ke Google Sheets)

Sekarang di halaman detail LOP ada tombol **"💾 Simpan Perubahan"** — field yang diedit di web akan langsung tersimpan ke Google Sheets aslinya (dicocokkan lewat kolom **SITE ID**, jadi kolom itu sendiri tidak bisa diedit).

Fitur ini butuh **Google Service Account** (akun khusus untuk aplikasi, beda dari akun Google pribadi) karena metode CSV publik yang dipakai untuk membaca data sifatnya **read-only**. Berikut langkah bikin dari awal:

### 1. Buat project & aktifkan Google Sheets API
1. Buka https://console.cloud.google.com/ → login pakai akun Google kamu.
2. Klik dropdown project di kiri atas → **New Project** → kasih nama bebas (mis. "monitoring-dashboard") → **Create**.
3. Pastikan project barusan aktif (cek dropdown kiri atas).
4. Buka menu **APIs & Services → Library**, cari **"Google Sheets API"**, klik, lalu klik **Enable**.

### 2. Buat Service Account
1. Masih di **APIs & Services**, buka **Credentials** (menu kiri).
2. Klik **+ Create Credentials → Service account**.
3. Isi nama bebas (mis. "dashboard-writer") → **Create and Continue** → role boleh di-skip (Continue) → **Done**.
4. Di halaman Credentials, klik service account yang baru dibuat.
5. Buka tab **Keys** → **Add Key → Create new key** → pilih **JSON** → **Create**.
6. File `.json` otomatis ke-download — **simpan baik-baik, jangan di-share/commit ke GitHub**.

### 3. Share spreadsheet ke Service Account
1. Buka file JSON tadi, cari field `"client_email"` — copy alamat emailnya (formatnya seperti `xxx@xxx.iam.gserviceaccount.com`).
2. Buka Google Sheets sumber data dashboard ini → klik **Share** (kanan atas).
3. Paste email tadi, set akses ke **Editor**, lalu **Send/Share**.

### 4. Pasang credential-nya di Railway
1. Buka project Railway → tab **Variables**.
2. Tambah variable baru:
   - Name: `GOOGLE_SERVICE_ACCOUNT_JSON`
   - Value: **buka file JSON tadi pakai text editor, copy SELURUH isinya (dari `{` sampai `}`), paste apa adanya** (Railway support value multi-baris).
3. Save → Railway otomatis redeploy.

### 5. Cek apakah sudah aktif
Buka `https://<domain-railway-kamu>/api/sheets-write-status` di browser. Kalau muncul `{"ready":true}`, fitur update sudah aktif. Kalau `{"ready":false,...}`, baca pesan `reason`-nya (biasanya berarti env var belum ke-set atau JSON-nya tidak valid).

**Catatan keamanan:** siapa pun yang bisa buka dashboard ini otomatis bisa mengedit data (belum ada login/otorisasi user per-role). Kalau nanti perlu dibatasi siapa saja yang boleh edit kolom apa saja, kasih tau — bisa ditambahkan.



| Endpoint | Keterangan |
|---|---|
| `GET /api/sheets` | Daftar nama sheet |
| `GET /api/data/:sheet?search=...&filter_KolomX=NilaiY` | Data sheet + search + filter |
| `GET /api/options/:sheet/:column` | Daftar nilai unik suatu kolom (untuk dropdown filter) |
| `GET /api/summary` | Ringkasan jumlah baris tiap sheet |
| `GET /api/mbb-notes` / `POST /api/mbb-notes` | Baca / simpan Catatan di halaman Tree Diagram MBB |
| `GET /api/sheets-write-status` | Cek apakah fitur update-ke-Sheets sudah aktif |
| `POST /api/update-row` | Update 1 baris (LOP) di sheet manapun berdasarkan SITE ID, langsung ke Google Sheets asli |
| `GET /health` | Health check |

## Troubleshooting

- **Error "tidak bisa diakses publik"**: ubah sharing setting spreadsheet ke "Anyone with the link can view".
- **Nama kolom aneh/kosong**: pastikan baris pertama tiap sheet adalah header (nama kolom), tanpa baris judul/merge cell di atasnya.
- **Data tidak update**: klik "🔄 Refresh Data" untuk bypass cache 60 detik.