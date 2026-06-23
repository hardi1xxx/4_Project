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

// Kolom status utama per sheet (untuk kartu angka besar & grafik)
const STATUS_COLUMN = {
  MBB: "Status Pekerjaan",
  OLO: "STATUS PEKERJAAN",
  FBB: "Status Fisik",
  HEM: "PROGRESS JT LAST UPDATE",
  PT2: "STATUS LOP",
};

// Cache sederhana di memori supaya tidak terus-menerus menghantam Google
const cache = {
  data: {},     // { MBB: [...rows], OLO: [...rows], ... }
  lastFetch: {} // { MBB: timestamp, ... }
};
const CACHE_TTL_MS = 60 * 1000; // 60 detik

// ============================================================
// FUNGSI AMBIL DATA DARI GOOGLE SHEETS (CSV export per-sheet)
// ============================================================

function normalizeKey(str) {
  return String(str ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// Cari header sebenarnya: baris pertama yang punya cukup banyak sel terisi
// (mengatasi sheet yang punya baris judul/merge cell sebelum baris header asli)
function detectHeaderRowIndex(rawRows) {
  let bestIndex = 0;
  let bestScore = -1;
  const maxCols = rawRows.reduce((m, r) => Math.max(m, r.length), 0);

  for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
    const row = rawRows[i];
    const filled = row.filter((c) => String(c ?? "").trim() !== "").length;
    // Skor: jumlah sel terisi, dengan syarat minimal isi > 1 sel dan bukan baris kosong total
    if (filled >= 2 && filled > bestScore) {
      bestScore = filled;
      bestIndex = i;
    }
  }
  return bestIndex;
}

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

  // Parse mentah dulu (array of array) supaya bisa deteksi baris header asli
  const rawRows = parse(csvText, {
    skip_empty_lines: false,
    relax_column_count: true,
    trim: true,
  });

  if (rawRows.length === 0) return [];

  const headerIdx = detectHeaderRowIndex(rawRows);
  const headerRaw = rawRows[headerIdx];

  // Bersihkan nama header: trim, isi nama default kalau kosong, dedup duplikat
  const seen = {};
  const headers = headerRaw.map((h, i) => {
    let name = String(h ?? "").trim();
    if (!name) name = `Kolom_${i + 1}`;
    if (seen[name] !== undefined) {
      seen[name]++;
      name = `${name}_${seen[name]}`;
    } else {
      seen[name] = 0;
    }
    return name;
  });

  const dataRows = rawRows.slice(headerIdx + 1);

  const records = dataRows
    .filter((r) => r.some((c) => String(c ?? "").trim() !== "")) // skip baris benar2 kosong
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = r[i] !== undefined ? String(r[i]).trim() : "";
      });
      return obj;
    });

  return records;
}

// Cari nilai kolom status dengan pencocokan fleksibel:
// exact match -> case-insensitive/trim match -> partial contains match
function getStatusValue(row, statusColName) {
  if (row[statusColName] !== undefined) return row[statusColName];

  const target = normalizeKey(statusColName);
  const keys = Object.keys(row);

  // cocokkan exact setelah dinormalisasi (beda kapital/spasi)
  let match = keys.find((k) => normalizeKey(k) === target);
  if (match) return row[match];

  // cocokkan partial (salah satu mengandung yang lain)
  match = keys.find(
    (k) => normalizeKey(k).includes(target) || target.includes(normalizeKey(k))
  );
  if (match) return row[match];

  return undefined;
}

function resolveStatusColumn(row, statusColName) {
  if (!row) return statusColName;
  if (row[statusColName] !== undefined) return statusColName;
  const target = normalizeKey(statusColName);
  const keys = Object.keys(row);
  let match = keys.find((k) => normalizeKey(k) === target);
  if (match) return match;
  match = keys.find(
    (k) => normalizeKey(k).includes(target) || target.includes(normalizeKey(k))
  );
  return match || statusColName;
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

// Statistik status (untuk kartu angka besar + grafik) - satu sheet
app.get("/api/stats/:sheet", async (req, res) => {
  const sheetName = req.params.sheet.toUpperCase();
  if (!SHEET_NAMES.includes(sheetName)) {
    return res.status(404).json({ error: `Sheet "${sheetName}" tidak dikenal.` });
  }
  try {
    const rows = await getSheetData(sheetName);
    const statusCol = STATUS_COLUMN[sheetName];
    const resolvedCol = resolveStatusColumn(rows[0], statusCol);
    const counts = {};
    let withStatus = 0;

    rows.forEach((row) => {
      let val = String(getStatusValue(row, statusCol) ?? "").trim();
      if (!val) val = "(Kosong)";
      else withStatus++;
      counts[val] = (counts[val] || 0) + 1;
    });

    const breakdown = Object.entries(counts)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    res.json({
      sheet: sheetName,
      statusColumn: statusCol,
      resolvedColumn: resolvedCol,
      total: rows.length,
      withStatus,
      breakdown,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, sheet: sheetName, statusColumn: STATUS_COLUMN[sheetName] });
  }
});

// Statistik semua sheet sekaligus (untuk halaman overview)
app.get("/api/stats-all", async (req, res) => {
  const result = {};
  for (const sheetName of SHEET_NAMES) {
    const statusCol = STATUS_COLUMN[sheetName];
    try {
      const rows = await getSheetData(sheetName);
      const counts = {};
      let withStatus = 0;
      rows.forEach((row) => {
        let val = String(getStatusValue(row, statusCol) ?? "").trim();
        if (!val) val = "(Kosong)";
        else withStatus++;
        counts[val] = (counts[val] || 0) + 1;
      });
      const breakdown = Object.entries(counts)
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count);

      result[sheetName] = {
        statusColumn: statusCol,
        total: rows.length,
        withStatus,
        breakdown,
        error: null,
      };
    } catch (err) {
      result[sheetName] = {
        statusColumn: statusCol,
        total: 0,
        withStatus: 0,
        breakdown: [],
        error: err.message,
      };
    }
  }
  res.json(result);
});

// Debug: cek header asli, jumlah baris, dan beberapa sample data
app.get("/api/debug/:sheet", async (req, res) => {
  const sheetName = req.params.sheet.toUpperCase();
  if (!SHEET_NAMES.includes(sheetName)) {
    return res.status(404).json({ error: `Sheet "${sheetName}" tidak dikenal.` });
  }
  try {
    const rows = await getSheetData(sheetName, true); // selalu fresh
    const statusCol = STATUS_COLUMN[sheetName];
    const resolvedCol = resolveStatusColumn(rows[0], statusCol);
    res.json({
      sheet: sheetName,
      totalRowsFetched: rows.length,
      columnsDetected: rows.length > 0 ? Object.keys(rows[0]) : [],
      statusColumnExpected: statusCol,
      statusColumnResolved: resolvedCol,
      sampleRows: rows.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});