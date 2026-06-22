const express = require("express");
const fetch = require("node-fetch");
const { parse } = require("csv-parse/sync");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ============================================================
// KONFIGURASI
// ============================================================
// ID Google Spreadsheet (dari URL)
const SPREADSHEET_ID =
  process.env.SHEET_ID || "1MqKFY3mn7-Qa2xn9kslKPKYCF15ONWPf71_dZuIF458";

// Daftar sheet/tab yang dimonitor
const SHEET_NAMES = ["MBB", "OLO", "HEM", "FBB", "PT2"];

// Cache sederhana di memori supaya tidak terus-menerus menghantam Google
const cache = {
  data: {},     // { MBB: [...rows], OLO: [...rows], ... }
  lastFetch: {} // { MBB: timestamp, ... }
};
const CACHE_TTL_MS = 60 * 1000; // 60 detik

// ============================================================
// FUNGSI AMBIL DATA DARI GOOGLE SHEETS (CSV export per-sheet)
// ============================================================
async function fetchSheetCSV(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    sheetName
  )}`;

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `Gagal mengambil sheet "${sheetName}" (status ${res.status}). Pastikan spreadsheet sudah di-share "Anyone with the link can view".`
    );
  }
  const csvText = await res.text();

  // Kalau Google mengembalikan halaman HTML (login/akses ditolak), bukan CSV
  if (csvText.trim().startsWith("<")) {
    throw new Error(
      `Sheet "${sheetName}" tidak bisa diakses publik. Pastikan link sharing diatur ke "Anyone with the link can view".`
    );
  }

  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  return records;
}

async function getSheetData(sheetName, forceRefresh = false) {
  const now = Date.now();
  const isFresh =
    cache.data[sheetName] &&
    now - (cache.lastFetch[sheetName] || 0) < CACHE_TTL_MS;

  if (isFresh && !forceRefresh) {
    return cache.data[sheetName];
  }

  const rows = await fetchSheetCSV(sheetName);
  cache.data[sheetName] = rows;
  cache.lastFetch[sheetName] = now;
  return rows;
}

// ============================================================
// API ROUTES
// ============================================================

// Daftar sheet yang tersedia
app.get("/api/sheets", (req, res) => {
  res.json({ sheets: SHEET_NAMES });
});

// Ambil data 1 sheet, dengan optional search & filter
// /api/data/MBB?search=jakarta&kolom=Status&nilai=Active
app.get("/api/data/:sheet", async (req, res) => {
  const sheetName = req.params.sheet.toUpperCase();
  if (!SHEET_NAMES.includes(sheetName)) {
    return res.status(404).json({ error: `Sheet "${sheetName}" tidak dikenal.` });
  }

  const refresh = req.query.refresh === "1";

  try {
    let rows = await getSheetData(sheetName, refresh);

    // Free-text search di semua kolom
    const search = (req.query.search || "").trim().toLowerCase();
    if (search) {
      rows = rows.filter((row) =>
        Object.values(row).some((val) =>
          String(val ?? "").toLowerCase().includes(search)
        )
      );
    }

    // Filter per kolom: filter_<NamaKolom>=nilai (bisa multi)
    Object.keys(req.query).forEach((key) => {
      if (key.startsWith("filter_")) {
        const col = key.replace("filter_", "");
        const val = String(req.query[key] || "").trim();
        if (val) {
          rows = rows.filter(
            (row) => String(row[col] ?? "").trim() === val
          );
        }
      }
    });

    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    res.json({
      sheet: sheetName,
      total: rows.length,
      columns,
      rows,
      lastUpdated: new Date(cache.lastFetch[sheetName] || Date.now()).toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Ambil opsi unik untuk sebuah kolom (buat populate dropdown filter)
app.get("/api/options/:sheet/:column", async (req, res) => {
  const sheetName = req.params.sheet.toUpperCase();
  const column = req.params.column;
  if (!SHEET_NAMES.includes(sheetName)) {
    return res.status(404).json({ error: `Sheet "${sheetName}" tidak dikenal.` });
  }
  try {
    const rows = await getSheetData(sheetName);
    const values = new Set();
    rows.forEach((r) => {
      const v = String(r[column] ?? "").trim();
      if (v) values.add(v);
    });
    res.json({ column, options: Array.from(values).sort() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rangkuman semua sheet sekaligus (untuk halaman overview)
app.get("/api/summary", async (req, res) => {
  try {
    const summary = {};
    for (const name of SHEET_NAMES) {
      try {
        const rows = await getSheetData(name);
        summary[name] = { total: rows.length, error: null };
      } catch (err) {
        summary[name] = { total: 0, error: err.message };
      }
    }
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});
