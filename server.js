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

// ============================================================
// KOLOM STATUS BERDASARKAN POSISI (HURUF KOLOM) — sesuai konfirmasi user
// Ini cara paling PASTI untuk ambil kolom status yang benar, karena tidak
// bergantung sama sekali pada nama header (yang bisa duplikat/berubah-ubah).
// Kalau di-set, ini akan dipakai LEBIH DULU sebelum fallback ke pencarian
// berdasarkan nama (STATUS_COLUMN) di atas.
// ============================================================
const STATUS_COLUMN_LETTER = {
  MBB: "U",   // Kolom U = Status Pekerjaan
  OLO: "Q",   // Kolom Q = STATUS PEKERJAAN
  FBB: "AH",  // Kolom AH = Status Fisik
  PT2: "K",   // Kolom K = STATUS LOP
  HEM: "AC",  // Kolom AC = PROGRESS JT LAST UPDATE
};

// ============================================================
// PENGECUALIAN BARIS (row exclusion) PER SHEET
// Baris yang cocok dengan aturan di sini akan DIBUANG SEPENUHNYA dari
// total/breakdown/grafik untuk sheet tersebut (bukan cuma disembunyikan
// dari grouping status, tapi benar-benar tidak dihitung).
//
// Format: { SHEET: { columnLetter: "C", excludeIfContains: ["CO 2025", "ADDITIONAL CO"] } }
// "excludeIfContains" dicocokkan secara case-insensitive & partial (substring).
// ============================================================
const ROW_EXCLUSION_RULES = {
  HEM: {
    columnLetter: "C", // Kolom C = STATUS WO (TIF)
    excludeIfContains: ["CO 2025", "ADDITIONAL CO"],
  },
};

// Cek apakah satu baris (objek hasil parsing, dengan `headers` array
// berurutan sesuai posisi asli) harus DIBUANG berdasarkan ROW_EXCLUSION_RULES.
function shouldExcludeRow(sheetName, row, headers) {
  const rule = ROW_EXCLUSION_RULES[sheetName];
  if (!rule) return false;

  const idx = colLetterToIndex(rule.columnLetter);
  if (idx < 0 || idx >= headers.length) return false;

  const colName = headers[idx];
  const val = normalizeKey(row[colName]);
  if (!val) return false;

  return rule.excludeIfContains.some((needle) => val.includes(normalizeKey(needle)));
}

// Konversi huruf kolom spreadsheet (A, B, ..., Z, AA, AB, ...) ke index
// array berbasis 0. Contoh: "A" -> 0, "U" -> 20, "AC" -> 28, "AH" -> 33.
function colLetterToIndex(letter) {
  const clean = String(letter ?? "").trim().toUpperCase();
  let n = 0;
  for (const ch of clean) {
    const code = ch.charCodeAt(0) - 64; // 'A' -> 1
    if (code < 1 || code > 26) return -1; // huruf tidak valid
    n = n * 26 + code;
  }
  return n - 1; // ke index berbasis 0
}

// ============================================================
// GROUPING STATUS
// Memetakan nilai status mentah (yang ada di tiap sheet) ke kategori
// standar yang sama untuk semua project, supaya kartu & grafik bisa
// dibandingkan apple-to-apple lintas sheet.
// Urutan GROUP_ORDER menentukan urutan tampil di kartu/grafik (urutan
// funnel proses, bukan urutan jumlah terbanyak).
// ============================================================
const GROUP_ORDER = [
  "APPROVAL",
  "SURVEY/PERIJINAN",
  "PERSIAPAN",
  "MATDEV",
  "INSTALASI",
  "FINISH INSTAL",
  "TESTCOM/GOLIVE",
  "Kendala/DROP",
];

const STATUS_GROUPS = {
  "APPROVAL": {
    FBB: [],
    PT2: ["1.DESIGN", "2.APPROVAL"],
    MBB: ["2. L0 DRM"],
    OLO: ["01. Approval IHLD", "03. DRM", "13. HOLD"],
    HEM: ["02. REDESIGN", "17. HOLD"],
  },
  "SURVEY/PERIJINAN": {
    FBB: ["01. PERIJINAN"],
    PT2: [],
    MBB: ["1. L0 Survey", "1.1 Done Survey", "3. L0 Progress Perizinan"],
    OLO: ["02. Survey", "04. Perizinan"],
    HEM: ["01. SURVEY", "04. PERIZINAN"],
  },
  "PERSIAPAN": {
    FBB: ["02. PERSIAPAN"],
    PT2: [],
    MBB: [],
    OLO: [],
    HEM: ["03. PERSIAPAN"],
  },
  "MATDEV": {
    FBB: ["03. MATDEV"],
    PT2: [],
    MBB: ["4. L0 Material Delivery"],
    OLO: ["05. Matdel"],
    HEM: ["05. MATERIAL DELIVERY"],
  },
  "INSTALASI": {
    FBB: ["04. INSTALASI"],
    PT2: ["3.OGP DEPLOY"],
    MBB: ["5.0 L0 Progress FO"],
    OLO: ["06. Instalasi"],
    HEM: ["06. OGP INSTALASI"],
  },
  "FINISH INSTAL": {
    FBB: ["05. FINISH INSTALASI"],
    PT2: ["4.FINISH INSTALL"],
    MBB: ["6. L0 Ready", "7. L1 Ready"],
    OLO: ["07. Finish Instalasi"],
    HEM: ["07. FINISH INSTALASI"],
  },
  "TESTCOM/GOLIVE": {
    FBB: ["06. GOLIVE", "07. UT", "08. PEMBERKASAN", "09. REKON", "10. BAST"],
    PT2: ["5.GOLIVE"],
    MBB: ["7. L3. OA Confirmation", "5.1 L0 Progress - Issue BTS"],
    OLO: ["08. Golive", "15. OA (JT)", "16. OA (PT1)"],
    HEM: ["10. GOLIVE"],
  },
  "Kendala/DROP": {
    FBB: ["10.1 BAST 2025", "00. DROP"],
    PT2: ["0.DROP", "0.KENDALA"],
    MBB: [
      "0. HOLD",
      "0.1 Proposed Drop",
      "0.2 L0 Drop",
      "0.3 Drop MoM",
      "0.1 Need Confirm by Tsel",
      "0.2 Confirmed Batal by Tsel",
    ],
    OLO: ["00.1 Need Confirm", "10. UT", "00.2 Confirmed Batal", "01. Drop", "00. Plan Drop", "00.3 Drop MOM"],
    HEM: ["18. PLAN DROP", "19. READY PT1", "20. DROP"],
  },
};

// Normalisasi teks status untuk pencocokan ketat (case/spasi diabaikan)
function normalizeStatusText(str) {
  return String(str ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Normalisasi "longgar": buang semua spasi & titik, untuk menangani
// perbedaan penulisan kecil seperti "3.OGP DEPLOY" vs "3. OGP DEPLOY"
function normalizeStatusTextLoose(str) {
  return normalizeStatusText(str).replace(/[\s.]+/g, "");
}

// Bangun lookup table sekali di awal: per sheet, dari nilai status mentah
// (yang sudah dinormalisasi) -> nama grup
function buildGroupLookups() {
  const lookups = {};
  SHEET_NAMES.forEach((sheet) => {
    lookups[sheet] = { exact: new Map(), loose: new Map() };
  });

  Object.entries(STATUS_GROUPS).forEach(([groupName, perSheet]) => {
    Object.entries(perSheet).forEach(([sheet, values]) => {
      if (!lookups[sheet]) return;
      values.forEach((v) => {
        lookups[sheet].exact.set(normalizeStatusText(v), groupName);
        lookups[sheet].loose.set(normalizeStatusTextLoose(v), groupName);
      });
    });
  });

  return lookups;
}

const GROUP_LOOKUPS = buildGroupLookups();
const UNGROUPED_LABEL = "Lainnya / Belum Dipetakan";

// Cari grup untuk satu nilai status mentah pada sheet tertentu.
// Strategi: exact match (setelah normalisasi) -> loose match (tanpa
// spasi/titik) -> kalau tidak ketemu sama sekali, masuk kategori
// "Lainnya / Belum Dipetakan" (supaya kelihatan kalau ada nilai baru
// di spreadsheet yang belum dimasukkan ke STATUS_GROUPS).
function getStatusGroup(sheetName, rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return "(Kosong)";

  const lookup = GROUP_LOOKUPS[sheetName];
  if (!lookup) return UNGROUPED_LABEL;

  const exactKey = normalizeStatusText(raw);
  if (lookup.exact.has(exactKey)) return lookup.exact.get(exactKey);

  const looseKey = normalizeStatusTextLoose(raw);
  if (lookup.loose.has(looseKey)) return lookup.loose.get(looseKey);

  return UNGROUPED_LABEL;
}

// Cache sederhana di memori supaya tidak terus-menerus menghantam Google
const cache = {
  data: {},     // { MBB: [...rows], OLO: [...rows], ... } -- SUDAH difilter exclusion rules
  headers: {},  // { MBB: [...nama kolom berurutan sesuai posisi asli], ... }
  rawCount: {}, // { MBB: jumlah baris SEBELUM exclusion rules, ... }
  headerIdx: {},     // { MBB: index baris yang dipakai sebagai header, ... }
  totalRawRows: {},  // { MBB: total baris mentah di CSV (termasuk header & baris kosong), ... }
  lastFetch: {} // { MBB: timestamp, ... }
};
// Refresh setiap 1 jam — data di-cache di server selama ini, dan frontend
// juga auto-reload mengikuti interval yang sama (lihat index.html).
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 jam

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
function detectHeaderRowIndex(rawRows, expectedColumnName) {
  const scanLimit = Math.min(rawRows.length, 30);

  // Prioritas: cari baris yang benar2 mengandung teks nama kolom status yang
  // diharapkan (mis. "STATUS FISIK", "PROGRESS JT LAST UPDATE"). Ini jauh
  // lebih akurat daripada menebak dari "baris paling banyak terisi", karena
  // untuk sheet besar, baris DATA yang lengkap terisi sering punya lebih
  // banyak sel terisi daripada baris header itu sendiri (kalau header ada
  // sel kosong/merge) — yang menyebabkan SEMUA data sebelum baris itu
  // ikut terhapus (inilah sebab data FBB/HEM hilang ratusan baris).
  if (expectedColumnName) {
    const target = normalizeKey(expectedColumnName);
    for (let i = 0; i < scanLimit; i++) {
      const row = rawRows[i];
      const hasMatch = row.some((c) => {
        const norm = normalizeKey(c);
        return norm && (norm === target || norm.includes(target) || target.includes(norm));
      });
      if (hasMatch) return i;
    }
  }

  // Fallback: baris dengan sel terisi terbanyak (hanya kalau pencarian teks gagal)
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
    const row = rawRows[i];
    const filled = row.filter((c) => String(c ?? "").trim() !== "").length;
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

  const headerIdx = detectHeaderRowIndex(rawRows, STATUS_COLUMN[sheetName]);
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

  return { records, headers, headerIdx, totalRawRows: rawRows.length };
}

// Cari kandidat kolom yang cocok dengan nama target: gabungan exact match
// (setelah normalisasi) DAN partial match (salah satu mengandung yang lain).
// PENTING: kalau header ada duplikat (misal 2 kolom sama-sama bernama
// "STATUS PEKERJAAN" di spreadsheet asli), parser akan rename yang kedua
// jadi "STATUS PEKERJAAN_1". Itu TIDAK exact-match lagi, jadi harus tetap
// ikut sebagai kandidat partial supaya tidak terlewat saat resolve kolom.
function findCandidateColumns(keys, statusColName) {
  const target = normalizeKey(statusColName);

  const exactMatches = keys.filter((k) => normalizeKey(k) === target);
  const partialMatches = keys.filter(
    (k) =>
      normalizeKey(k) !== target &&
      (normalizeKey(k).includes(target) || target.includes(normalizeKey(k)))
  );

  const candidates = [...exactMatches, ...partialMatches];
  const tier = exactMatches.length > 0 ? "exact+partial" : "partial-only";
  return { candidates, exactMatches, partialMatches, tier };
}

// Resolusi kolom status YANG BENAR.
// Prioritas:
// 1) Kalau STATUS_COLUMN_LETTER untuk sheet ini di-set, ambil kolom LANGSUNG
//    berdasarkan posisi (huruf kolom) dari `headers` (array nama kolom
//    berurutan sesuai posisi asli di spreadsheet). Ini cara paling pasti,
//    tidak peduli nama header-nya apa/duplikat/berubah.
// 2) Kalau tidak ada konfigurasi huruf (atau index di luar jangkauan),
//    fallback ke pencarian berdasarkan nama (exact/partial + variasi nilai
//    terbanyak) seperti sebelumnya.
function resolveStatusColumn(sheetName, rows, statusColName, headers) {
  // --- Prioritas 1: berdasarkan posisi huruf kolom ---
  const letter = STATUS_COLUMN_LETTER[sheetName];
  if (letter && headers && headers.length > 0) {
    const idx = colLetterToIndex(letter);
    if (idx >= 0 && idx < headers.length) {
      return headers[idx];
    }
  }

  // --- Prioritas 2 (fallback): pencarian berdasarkan nama ---
  if (!rows || rows.length === 0) return statusColName;
  const keys = Object.keys(rows[0]);

  const { candidates } = findCandidateColumns(keys, statusColName);
  if (candidates.length === 0) return statusColName;
  if (candidates.length === 1) return candidates[0];

  // Ambil sample (maks 500 baris) supaya tetap cepat untuk sheet besar
  const sample = rows.length > 500 ? rows.slice(0, 500) : rows;

  let bestCol = candidates[0];
  let bestScore = -1;
  candidates.forEach((col) => {
    const distinct = new Set();
    sample.forEach((r) => {
      const v = String(r[col] ?? "").trim();
      if (v) distinct.add(v);
    });
    if (distinct.size > bestScore) {
      bestScore = distinct.size;
      bestCol = col;
    }
  });

  return bestCol;
}

// Ambil nilai status dari 1 baris, berdasarkan nama kolom yang SUDAH
// di-resolve sebelumnya (lihat resolveStatusColumn). Tidak melakukan
// pencocokan ulang per baris supaya hasilnya konsisten untuk semua baris.
function getStatusValue(row, resolvedColumnName) {
  return row[resolvedColumnName];
}

async function getSheetData(sheetName, forceRefresh = false) {
  const now = Date.now();
  const isFresh =
    cache.data[sheetName] &&
    now - (cache.lastFetch[sheetName] || 0) < CACHE_TTL_MS;

  if (isFresh && !forceRefresh) {
    return cache.data[sheetName];
  }

  const { records, headers, headerIdx, totalRawRows } = await fetchSheetCSV(sheetName);

  // Buang baris yang masuk aturan pengecualian (mis. HEM: kolom C berisi
  // "CO 2025" / "ADDITIONAL CO" tidak dihitung sama sekali).
  const filtered = records.filter((row) => !shouldExcludeRow(sheetName, row, headers));

  cache.data[sheetName] = filtered;
  cache.headers[sheetName] = headers;
  cache.rawCount[sheetName] = records.length; // sebelum dikecualikan, untuk debug
  cache.headerIdx[sheetName] = headerIdx;
  cache.totalRawRows[sheetName] = totalRawRows;
  cache.lastFetch[sheetName] = now;
  return filtered;
}

// Ambil header asli (berurutan sesuai posisi kolom di spreadsheet) untuk
// 1 sheet. Mengandalkan getSheetData supaya cache headers selalu konsisten
// dengan cache rows (dipanggil setelah getSheetData supaya pasti sudah ada).
async function getSheetHeaders(sheetName) {
  if (!cache.headers[sheetName]) {
    await getSheetData(sheetName);
  }
  return cache.headers[sheetName] || [];
}

// Hitung breakdown status untuk satu sheet, dalam 2 bentuk:
// - breakdown      : sudah dikelompokkan ke 8 kategori standar (GROUP_ORDER),
//                     diurutkan sesuai urutan funnel proses (bukan jumlah terbanyak)
// - rawBreakdown    : nilai status mentah asli dari spreadsheet (untuk debug)
// - unmatchedValues : nilai mentah yang TIDAK ketemu mapping-nya di STATUS_GROUPS
//                     (kalau ada, berarti ada nilai baru di sheet yang perlu
//                     ditambahkan ke mapping)
async function computeStatusBreakdown(sheetName, rows, statusCol) {
  const headers = await getSheetHeaders(sheetName);
  const resolvedCol = resolveStatusColumn(sheetName, rows, statusCol, headers);

  const groupCounts = {};
  const rawCounts = {};
  const unmatched = {};
  let withStatus = 0;

  rows.forEach((row) => {
    let val = String(getStatusValue(row, resolvedCol) ?? "").trim();
    if (!val) val = "(Kosong)";
    else withStatus++;

    rawCounts[val] = (rawCounts[val] || 0) + 1;

    const group = getStatusGroup(sheetName, val);
    groupCounts[group] = (groupCounts[group] || 0) + 1;

    if (group === UNGROUPED_LABEL && val !== "(Kosong)") {
      unmatched[val] = (unmatched[val] || 0) + 1;
    }
  });

  // Urutkan breakdown grup sesuai GROUP_ORDER, lalu "(Kosong)", lalu "Lainnya"
  const orderedGroupNames = [...GROUP_ORDER, "(Kosong)", UNGROUPED_LABEL];
  const breakdown = orderedGroupNames
    .filter((g) => groupCounts[g] !== undefined)
    .map((g) => ({ status: g, count: groupCounts[g] }));

  const rawBreakdown = Object.entries(rawCounts)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  const unmatchedValues = Object.entries(unmatched)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  return { breakdown, rawBreakdown, unmatchedValues, withStatus, resolvedColumn: resolvedCol };
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

    // Filter per kolom (checkbox, bisa pilih lebih dari 1 nilai sekaligus):
    // filter_<NamaKolom>=nilai1,nilai2,nilai3 -> baris cocok kalau nilainya
    // ADA SALAH SATU dari nilai yang dipilih (logika OR antar nilai dalam 1
    // kolom). Beberapa kolom berbeda tetap digabung dengan AND.
    Object.keys(req.query).forEach((key) => {
      if (key.startsWith("filter_")) {
        const col = key.replace("filter_", "");
        const rawVal = String(req.query[key] || "").trim();
        if (!rawVal) return;
        const selectedValues = rawVal
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v !== "");
        if (selectedValues.length === 0) return;

        rows = rows.filter((row) =>
          selectedValues.includes(String(row[col] ?? "").trim())
        );
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
    const { breakdown, rawBreakdown, unmatchedValues, withStatus, resolvedColumn } =
      await computeStatusBreakdown(sheetName, rows, statusCol);

    res.json({
      sheet: sheetName,
      statusColumn: statusCol,
      resolvedColumn,
      total: rows.length,
      withStatus,
      breakdown,        // sudah dikelompokkan (dipakai kartu & grafik)
      rawBreakdown,      // nilai mentah asli (untuk debug/detail)
      unmatchedValues,   // nilai mentah yang belum ada mapping grup-nya
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
      const { breakdown, rawBreakdown, unmatchedValues, withStatus } =
        await computeStatusBreakdown(sheetName, rows, statusCol);

      result[sheetName] = {
        statusColumn: statusCol,
        total: rows.length,
        withStatus,
        breakdown,
        rawBreakdown,
        unmatchedValues,
        error: null,
      };
    } catch (err) {
      result[sheetName] = {
        statusColumn: statusCol,
        total: 0,
        withStatus: 0,
        breakdown: [],
        rawBreakdown: [],
        unmatchedValues: [],
        error: err.message,
      };
    }
  }
  res.json(result);
});

// Debug: lihat nilai status mentah yang BELUM ketemu mapping grup-nya,
// untuk semua sheet sekaligus. Berguna kalau ada penambahan/typo status baru
// di spreadsheet supaya bisa ditambahkan ke STATUS_GROUPS di server.js.
app.get("/api/group-debug", async (req, res) => {
  const result = {};
  for (const sheetName of SHEET_NAMES) {
    try {
      const rows = await getSheetData(sheetName);
      const statusCol = STATUS_COLUMN[sheetName];
      const { unmatchedValues } = await computeStatusBreakdown(sheetName, rows, statusCol);
      result[sheetName] = unmatchedValues;
    } catch (err) {
      result[sheetName] = { error: err.message };
    }
  }
  res.json(result);
});

// Kebalikan dari colLetterToIndex: index berbasis 0 -> huruf kolom (A, B, ..., Z, AA, ...)
function colIndexToLetter(index) {
  let n = index + 1;
  let letter = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// Debug: cek header asli, jumlah baris, dan beberapa sample data
app.get("/api/debug/:sheet", async (req, res) => {
  const sheetName = req.params.sheet.toUpperCase();
  if (!SHEET_NAMES.includes(sheetName)) {
    return res.status(404).json({ error: `Sheet "${sheetName}" tidak dikenal.` });
  }
  try {
    const rows = await getSheetData(sheetName, true); // selalu fresh
    const headers = await getSheetHeaders(sheetName);
    const statusCol = STATUS_COLUMN[sheetName];
    const letter = STATUS_COLUMN_LETTER[sheetName];
    const letterIdx = letter ? colLetterToIndex(letter) : -1;
    const resolvedCol = resolveStatusColumn(sheetName, rows, statusCol, headers);
    const keys = rows.length > 0 ? Object.keys(rows[0]) : [];
    const { candidates, tier } = findCandidateColumns(keys, statusCol);

    // Peta SEMUA kolom -> huruf kolom, supaya bisa dicek manual dengan mudah
    // tanpa hitung sendiri (cocokkan dengan tampilan asli di Google Sheets).
    const allColumnsWithLetters = headers.map((h, i) => ({
      letter: colIndexToLetter(i),
      index: i,
      header: h,
    }));

    // Jumlah nilai unik & contoh nilai untuk kolom yang sedang dipakai sebagai
    // status (resolvedCol) — kalau cuma 1 nilai unik untuk ratusan baris,
    // kemungkinan besar kolom yang diambil SALAH (bukan kolom status asli).
    const distinctValues = new Set();
    rows.forEach((r) => distinctValues.add(String(r[resolvedCol] ?? "").trim()));

    res.json({
      sheet: sheetName,
      totalRowsFetched: rows.length,
      totalRowsBeforeExclusion: cache.rawCount[sheetName],
      excludedRowsCount: (cache.rawCount[sheetName] || 0) - rows.length,
      exclusionRuleApplied: ROW_EXCLUSION_RULES[sheetName] || null,
      totalRawCsvRows: cache.totalRawRows[sheetName],
      headerRowIndexUsed: cache.headerIdx[sheetName],
      headerRowContent: cache.totalRawRows[sheetName] != null ? headers : null,
      columnsDetected: headers,
      allColumnsWithLetters,
      statusColumnExpected: statusCol,
      statusColumnLetter: letter || null,
      statusColumnLetterIndex: letterIdx,
      headerAtThatLetter: letterIdx >= 0 && letterIdx < headers.length ? headers[letterIdx] : null,
      statusColumnResolved: resolvedCol,
      distinctValuesInResolvedColumn: distinctValues.size,
      sampleDistinctValues: Array.from(distinctValues).slice(0, 15),
      candidateColumnsByName: candidates, // kandidat kalau resolve by-name dipakai (fallback)
      matchTier: tier,
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