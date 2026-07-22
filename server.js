const express = require("express");
const fetch = require("node-fetch");
const { parse } = require("csv-parse/sync");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ============================================================
// KONFIGURASI
// ============================================================
// ID Google Spreadsheet (dari URL)
const SPREADSHEET_ID =
  process.env.SHEET_ID || "1MqKFY3mn7-Qa2xn9kslKPKYCF15ONWPf71_dZuIF458";

// Daftar sheet/tab yang dimonitor
const SHEET_NAMES = ["MBB", "OLO", "HEM", "FBB", "PT2", "QE"];

// Jika project logical name berbeda dengan nama tab di Google Sheets,
// gunakan mapping ini. Contoh: QE dipetakan ke tab "QERelok".
const SHEET_TAB_NAMES = {
  QE: "QERelok",
};

function resolveSheetTabName(sheetName) {
  return SHEET_TAB_NAMES[sheetName] || sheetName;
}

// Kolom status utama per sheet (untuk kartu angka besar & grafik)
const STATUS_COLUMN = {
  MBB: "Status Pekerjaan",
  OLO: "STATUS PEKERJAAN",
  FBB: "Status Fisik",
  HEM: "PROGRESS JT LAST UPDATE",
  PT2: "STATUS LOP",
  QE: "STATUS FISIK",
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
  QE: "S",    // Kolom S = STATUS FISIK pada tab QERelok
};

// ============================================================
// KONFIGURASI HALAMAN "TREE DIAGRAM" KHUSUS MBB
// Kolom tambahan (di luar kolom status) yang dipakai untuk membangun
// halaman ringkasan visual MBB (kartu keuangan, target Juli, breakdown
// per region, dsb). Semua berdasarkan huruf kolom di spreadsheet.
// ============================================================
const MBB_REGION_LETTER = "BO";      // Region/wilayah proyek
const MBB_PO_LETTER = "M";           // Nilai PO
const MBB_BOQ_LETTER = "AH";         // Nilai BoQ
const MBB_COMCASE_LETTER = "AJ";     // Nilai Comcase
const MBB_JULI_LETTER = "P";         // Kolom berisi keterangan target bulan (dicari teks "juli")

// Urutan status mentah MBB (kolom U) sesuai funnel proses, dipakai untuk
// tree diagram, kartu breakdown, dan tabel pivot per region di halaman MBB.
const MBB_STATUS_ORDER = [
  "0. HOLD",
  "0.1 Need Confirm by Tsel",
  "0.2 Confirmed Batal by Tsel",
  "1. L0 Survey",
  "1.1 Done Survey",
  "2. L0 DRM",
  "3. L0 Progress Perizinan",
  "4. L0 Material Delivery",
  "5.0 L0 Progress FO",
  "5.1 L0 Progress - Issue BTS",
  "6. L0 Ready",
  "7. L1 Ready",
  "7. L3. OA Confirmation",
];

// Parse angka dari format Rupiah Indonesia (titik ribuan, koma desimal,
// bisa ada "Rp" atau spasi). Mengembalikan 0 kalau tidak bisa di-parse.
function parseRupiahNumber(val) {
  if (val === null || val === undefined) return 0;
  let s = String(val).trim();
  if (!s) return 0;
  s = s.replace(/rp\.?/gi, "").replace(/\s+/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // format Indonesia: titik = ribuan, koma = desimal
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma && !hasDot) {
    const parts = s.split(",");
    if (parts[parts.length - 1].length <= 2) {
      s = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasDot && !hasComma) {
    const parts = s.split(".");
    if (parts.length > 1 && parts[parts.length - 1].length === 3 && parts.length > 2) {
      s = parts.join("");
    } else if (parts.length === 2 && parts[1].length === 3) {
      s = parts.join(""); // "1.234" -> ribuan
    }
  }
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

// ============================================================
// PENGECUALIAN / FILTER BARIS PER SHEET
// Baris yang cocok dengan aturan di sini akan DIBUANG SEPENUHNYA dari
// total/breakdown/grafik untuk sheet tersebut (bukan cuma disembunyikan
// dari grouping status, tapi benar-benar tidak dihitung).
//
// Setiap sheet bisa punya BEBERAPA rule sekaligus (dijalankan berurutan,
// digabung dengan logika AND — baris harus lolos SEMUA rule biar tetap
// dihitung). Ada 2 jenis mode:
//
// - "excludeIfContains"     : baris DIBUANG kalau nilai kolom itu
//                              mengandung salah satu dari `values`.
// - "includeOnlyIfContains" : baris HANYA DIPERTAHANKAN kalau nilai kolom
//                              itu mengandung salah satu dari `values`
//                              (baris lain dibuang). Dipakai misalnya untuk
//                              MBB yang cuma mau menghitung baris kolom B
//                              berisi "TIF".
//
// Pencocokan "contains" selalu case-insensitive & partial (substring).
// ============================================================
const ROW_FILTER_RULES = {
  MBB: [
    { columnLetter: "B", mode: "includeOnlyIfContains", values: ["TIF"] },
    { columnLetter: "U", mode: "excludeIfContains", values: ["0.3 Drop MoM"] },
  ],
  OLO: [
    { columnLetter: "Q", mode: "excludeIfContains", values: ["00.3 Drop MOM"] },
  ],
  HEM: [
    { columnLetter: "B", mode: "excludeIfContains", values: ["CO 2025", "ADDITIONAL CO"] },
  ],
  FBB: [
    { columnLetter: "BU", mode: "excludeIfContains", values: ["C.Tel.55/TK 000/JIFC-2Z50000/2026"] },
  ],
  QE: [
    { columnLetter: "J", mode: "excludeIfContains", values: ["0.SPMK TELKOM"] },
  ],
};

// Cek apakah satu baris (objek hasil parsing, dengan `headers` array
// berurutan sesuai posisi asli) harus DIBUANG berdasarkan ROW_FILTER_RULES.
function shouldExcludeRow(sheetName, row, headers) {
  // Aturan khusus QE (sudah ada sebelumnya): baris dengan kolom status
  // kosong dibuang, terlepas dari rule lain.
  if (sheetName === "QE") {
    const statusLetter = STATUS_COLUMN_LETTER[sheetName];
    if (statusLetter) {
      const statusIdx = colLetterToIndex(statusLetter);
      if (statusIdx >= 0 && statusIdx < headers.length) {
        const statusHeader = headers[statusIdx];
        const statusVal = normalizeKey(row[statusHeader]);
        if (!statusVal) return true;
      }
    }
  }

  const rules = ROW_FILTER_RULES[sheetName];
  if (!rules || rules.length === 0) return false;

  for (const rule of rules) {
    const idx = colLetterToIndex(rule.columnLetter);
    if (idx < 0 || idx >= headers.length) continue; // kolom tidak ada, lewati rule ini

    const colName = headers[idx];
    const val = normalizeKey(row[colName]);

    if (rule.mode === "excludeIfContains") {
      if (val && rule.values.some((needle) => val.includes(normalizeKey(needle)))) {
        return true; // buang
      }
    } else if (rule.mode === "includeOnlyIfContains") {
      const matches = val && rule.values.some((needle) => val.includes(normalizeKey(needle)));
      if (!matches) return true; // tidak cocok syarat wajib -> buang
    }
  }

  return false;
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
  "5.1 L0 Progress - Issue BTS",
  "7. L3. OA Confirmation",
  "15. OA (JT)",
  "16. OA (PT1)",
  "TESTCOM/GOLIVE",
  "00.1 Need Confirm",
  "00.2 Confirmed Batal",
  "00. Plan Drop",
  "01. Drop",
  "10. UT",
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
    QE: ["1.PERSIAPAN/PERIZINAN", "2.INSTALASI", "3.FINISH INSTALASI"],
  },
  "FINISH INSTAL": {
    FBB: ["05. FINISH INSTALASI"],
    PT2: ["4.FINISH INSTALL"],
    MBB: ["6. L0 Ready", "7. L1 Ready"],
    OLO: ["07. Finish Instalasi"],
    HEM: ["07. FINISH INSTALASI"],
  },

  "15. OA (JT)": {
    OLO: ["15. OA (JT)"],
  },
  "16. OA (PT1)": {
    OLO: ["16. OA (PT1)"],
  },
  "TESTCOM/GOLIVE": {
    FBB: ["06. GOLIVE", "07. UT", "08. PEMBERKASAN", "09. REKON", "10. BAST"],
    PT2: ["5.GOLIVE"],
    OLO: ["08. Golive"],
    HEM: ["10. GOLIVE"],
    QE: ["4.COMTEST", "5.UJI TERIMA"],
  },
  "5.1 L0 Progress - Issue BTS": {
    MBB: ["5.1 L0 Progress - Issue BTS"],
  },
  "7. L3. OA Confirmation": {
    MBB: ["7. L3. OA Confirmation"],
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
    // "00.3 Drop MOM" untuk OLO sudah dibuang total dari data lewat
    // ROW_FILTER_RULES (lihat di atas), jadi baris dengan status ini
    // seharusnya tidak pernah sampai ke sini. Tetap dicantumkan sebagai
    // jaring pengaman kalau suatu saat rule exclude-nya tidak match.
    OLO: ["00.3 Drop MOM"],
    QE: ["0.DROP"],
    HEM: ["18. PLAN DROP", "19. READY PT1", "20. DROP"],
  },
  // Status OLO berikut sebelumnya digabung jadi satu ke "Kendala/DROP".
  // Sekarang dipisah masing-masing jadi kategori/status sendiri.
  "01. Drop": {
    OLO: ["01. Drop"],
  },
  "00. Plan Drop": {
    OLO: ["00. Plan Drop"],
  },
  "00.1 Need Confirm": {
    OLO: ["00.1 Need Confirm"],
  },
  "00.2 Confirmed Batal": {
    OLO: ["00.2 Confirmed Batal"],
  },
  "10. UT": {
    OLO: ["10. UT"],
  },
};

// Normalisasi teks status untuk pencocokan ketat (case/spasi/tanda baca diabaikan)
function normalizeStatusText(str) {
  return String(str ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, "")
    .replace(/\s+/g, " ");
}

// Normalisasi "longgar": buang semua spasi dan semua karakter non-alfanumerik,
// jadi perbedaan kecil seperti titik, tanda kurung, atau garis bawah tidak
// menghalangi pencocokan.
function normalizeStatusTextLoose(str) {
  return normalizeStatusText(str).replace(/[^a-z0-9]+/g, "");
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

  const fallbackGroup = getStatusFallback(sheetName, raw);
  if (fallbackGroup) return fallbackGroup;

  if (sheetName === "HEM") {
    return getHemStatusFallback(raw);
  }

  if (sheetName === "MBB") {
    return raw;
  }

  return UNGROUPED_LABEL;
}

function getStatusFallback(sheetName, rawValue) {
  const raw = normalizeStatusText(rawValue);
  if (!raw) return null;

  if (sheetName === "MBB") {
    if (raw.includes("5 1 l0 progress") && raw.includes("issue bts")) {
      return "5.1 L0 Progress - Issue BTS";
    }
    if (raw.includes("7 l3 oa confirmation") || raw.includes("oa confirmation")) {
      return "7. L3. OA Confirmation";
    }
  }

  return null;
}

function inferMbbStatusFromNotes(row) {
  const note = normalizeStatusText(String(row["Note Progress"] || "") + " " + String(row["Resume Progress"] || ""));
  const extra = normalizeStatusText(String(row["Status Recti"] || "") + " " + String(row["Status Tsel"] || ""));
  if (!note && !extra) return null;

  const has = (terms, source = note) => terms.some((term) => source.includes(term));

  if (has(["issue bts", "issuebts", "bts"], note) && has(["progress"], note)) {
    return "5.1 L0 Progress - Issue BTS";
  }
  if (has(["oa confirmation", "oa konfirmasi", "oa confirm", "oa", "confirmation"], note)) {
    return "7. L3. OA Confirmation";
  }
  if (has(["approval", "approve", "approved"], note)) return "APPROVAL";
  if (has(["survey", "perijinan", "perizinan", "aanwijzing", "pid"], note)) return "SURVEY/PERIJINAN";
  if (has(["matdev", "material", "comcase", "nilai cc", "cc", "anggaran", "pembayaran", "dana cc", "kompensasi"], note)) return "MATDEV";
  if (has(["finish instal", "finish instalasi", "done install", "done instalasi", "install", "instalasi", "instal", "ont"], note)) return "FINISH INSTAL";
  if (has(["golive", "uat", "bast", "rekon", "pemberkasan", "oa confirmation", "oa ", "on air"], note)) return "TESTCOM/GOLIVE";
  if (has(["drop", "batal", "hold", "plan drop", "drop mom"], note)) return "Kendala/DROP";

  if (has(["6 on air", "on air", "done", "done install", "done instalasi", "ny install"], extra)) {
    return extra.includes("on air") ? "TESTCOM/GOLIVE" : "FINISH INSTAL";
  }

  return null;
}

function getHemStatusFallback(rawValue) {
  const raw = normalizeStatusText(rawValue);
  if (!raw) return UNGROUPED_LABEL;

  if (raw.includes("redesign") || raw.includes("hold")) return "APPROVAL";
  if (raw.includes("survey") || raw.includes("perizinan")) return "SURVEY/PERIJINAN";
  if (raw.includes("persiapan")) return "PERSIAPAN";
  if (raw.includes("material") || raw.includes("matdev") || raw.includes("delivery")) return "MATDEV";
  if (raw.includes("ogp") || raw.includes("instalasi") || raw.includes("installation")) return "INSTALASI";
  if (raw.includes("finish")) return "FINISH INSTAL";
  if (raw.includes("golive") || raw.includes("uat") || raw.includes("ut") || raw.includes("bast") || raw.includes("rekon") || raw.includes("pemberkasan") || raw.includes("oa")) return "TESTCOM/GOLIVE";
  if (raw.includes("plan drop") || raw.includes("ready pt") || raw.includes("drop")) return "Kendala/DROP";

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
// Refresh setiap 24 jam (1x sehari) — data di-cache di server selama ini, dan frontend
// juga auto-reload mengikuti interval yang sama (lihat index.html).
// Tombol "Refresh Data" di sidebar tetap bisa digunakan kapan saja untuk
// memaksa fetch data baru dari Google Sheets secara manual.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam (1x sehari)

// ============================================================
// FUNGSI AMBIL DATA DARI GOOGLE SHEETS (CSV export per-sheet)
// ============================================================

function normalizeKey(str) {
  return String(str ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// Cari header sebenarnya: baris yang mengandung teks nama kolom status yang
// diharapkan (mengatasi sheet yang punya baris judul/merge cell sebelum
// baris header asli).
//
// PENTING — bug yang sudah pernah terjadi: sebelumnya pencocokan teks
// memakai logika "salah satu mengandung yang lain" (target.includes(norm)).
// Ini SANGAT longgar — kalau ada SEL APA SAJA di baris manapun (sebelum
// baris header asli) yang isinya cuma teks pendek/legenda/catatan yang
// kebetulan jadi SUBSTRING dari nama kolom yang dicari (misal sel berisi
// "UPDATE" atau "LAST" akan otomatis "match" dengan target "PROGRESS JT
// LAST UPDATE"), maka baris yang SALAH itu kepilih jadi header. Akibatnya
// SEMUA baris data ikut bergeser/salah dan kolom yang dibaca jadi ngawur
// (ini yang menyebabkan HEM kolom AC selalu kebaca "Lainnya / Belum
// Dipetakan" untuk semua baris).
//
// Fix, 2 lapis (dari paling presisi ke paling longgar):
// 1) Kalau posisi huruf kolom sudah dikonfirmasi (expectedLetterIndex),
//    cek LANGSUNG di posisi itu saja — apakah teksnya exact match dengan
//    nama kolom yang diharapkan. Ini PALING akurat karena memvalidasi
//    posisi + teks sekaligus, tidak mungkin "ketipu" sel lain di kolom
//    berbeda.
// 2) Kalau tidak ada info posisi huruf, baru cek exact match di SEMBARANG
//    sel pada baris itu (masih exact, bukan substring lagi).
function detectHeaderRowIndex(rawRows, expectedColumnName, expectedLetterIndex) {
  const scanLimit = Math.min(rawRows.length, 30);
  const target = expectedColumnName ? normalizeKey(expectedColumnName) : "";
  const targetLoose = expectedColumnName ? normalizeStatusTextLoose(expectedColumnName) : "";

  // --- Lapis 1: cek persis di posisi kolom yang sudah dikonfirmasi ---
  if (target && typeof expectedLetterIndex === "number" && expectedLetterIndex >= 0) {
    for (let i = 0; i < scanLimit; i++) {
      const cellAtLetter = rawRows[i][expectedLetterIndex];
      const normalizedCell = normalizeStatusText(cellAtLetter);
      if (
        normalizeKey(cellAtLetter) === target ||
        normalizeStatusTextLoose(cellAtLetter) === targetLoose ||
        normalizedCell.includes(target)
      ) {
        return i;
      }
    }
  }

  // --- Lapis 2: exact/loose/substring match di sembarang sel pada baris (fallback) ---
  if (target) {
    for (let i = 0; i < scanLimit; i++) {
      const row = rawRows[i];
      const hasExactMatch = row.some((c) => normalizeKey(c) === target);
      const hasLooseMatch = row.some(
        (c) => normalizeStatusTextLoose(c) === targetLoose
      );
      const hasSubstringMatch = row.some((c) => normalizeStatusText(c).includes(target));
      if (hasExactMatch || hasLooseMatch || hasSubstringMatch) return i;
    }
  }

  // --- Lapis 3: baris dengan sel terisi terbanyak (fallback terakhir) ---
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
  const tabName = resolveSheetTabName(sheetName);
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    tabName
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

  const letter = STATUS_COLUMN_LETTER[sheetName];
  const expectedLetterIndex = letter ? colLetterToIndex(letter) : -1;
  const headerIdx = detectHeaderRowIndex(rawRows, STATUS_COLUMN[sheetName], expectedLetterIndex);
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

// Cari kandidat kolom yang cocok dengan nama target: gabungan exact match,
// loose match, dan partial match. Ini membantu jika nama header di sheet
// berubah tipis atau ada duplikat yang diberi suffix seperti "_1".
function findCandidateColumns(keys, statusColName) {
  const target = normalizeKey(statusColName);
  const targetLoose = normalizeStatusTextLoose(statusColName);

  const exactMatches = keys.filter((k) => normalizeKey(k) === target);
  const looseMatches = keys.filter(
    (k) =>
      normalizeStatusTextLoose(k) === targetLoose &&
      normalizeKey(k) !== target
  );
  const partialMatches = keys.filter((k) => {
    const normalized = normalizeKey(k);
    return (
      normalized !== target &&
      !looseMatches.includes(k) &&
      (normalized.includes(target) || target.includes(normalized) ||
        normalizeStatusTextLoose(k).includes(targetLoose) ||
        targetLoose.includes(normalizeStatusTextLoose(k)))
    );
  });

  const candidates = [...exactMatches, ...looseMatches, ...partialMatches];
  const tier = exactMatches.length > 0 ? "exact+partial" : looseMatches.length > 0 ? "loose+partial" : "partial-only";
  return { candidates, exactMatches, looseMatches, partialMatches, tier };
}

function headerLooksLikeExpected(header, expectedColumnName) {
  if (!header || !expectedColumnName) return false;
  const normalizedHeader = normalizeStatusTextLoose(header);
  const normalizedExpected = normalizeStatusTextLoose(expectedColumnName);
  return (
    normalizedHeader === normalizedExpected ||
    normalizedHeader.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedHeader)
  );
}

// Resolusi kolom status YANG BENAR.
// Prioritas:
// 1) Kalau STATUS_COLUMN_LETTER untuk sheet ini di-set, ambil kolom LANGSUNG
//    berdasarkan posisi (huruf kolom) dari `headers` (array nama kolom
//    berurutan sesuai posisi asli di spreadsheet).
// 2) Kalau header posisi ternyata tidak cocok atau kosong, fallback ke
//    pencarian berdasarkan nama (exact/loose/partial + variasi nilai).
function resolveStatusColumn(sheetName, rows, statusColName, headers) {
  // --- Prioritas 1: berdasarkan posisi huruf kolom ---
  const letter = STATUS_COLUMN_LETTER[sheetName];
  if (letter && headers && headers.length > 0) {
    const idx = colLetterToIndex(letter);
    if (idx >= 0 && idx < headers.length) {
      const candidate = headers[idx];
      if (candidate && String(candidate).trim() !== "" && headerLooksLikeExpected(candidate, statusColName)) {
        return candidate;
      }
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

  // Terapkan row exclusion rules jika ada untuk sheet ini
  // (untuk HEM: hapus baris CO 2025 & ADDITIONAL CO dari kolom C)
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

    if (sheetName === "MBB") {
      const rawGroup = getStatusGroup(sheetName, val);
      if (
        rawGroup === "OA" ||
        rawGroup === "7. L3. OA Confirmation" ||
        rawGroup === UNGROUPED_LABEL ||
        val === "(Kosong)"
      ) {
        const inferred = inferMbbStatusFromNotes(row);
        if (inferred) {
          val = inferred;
        }
      }
    }

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

    // Filter berdasarkan GRUP status (dipakai waktu klik salah satu baris
    // breakdown di kartu ringkasan) — cocokkan pakai logika grouping yang
    // SAMA PERSIS dengan yang menghasilkan angka breakdown (getStatusGroup),
    // supaya jumlah baris yang tampil selalu konsisten dengan angka di kartu.
    // Ini beda dari filter_<Kolom> biasa: filter_ cocokkan NILAI MENTAH persis,
    // sedangkan statusGroup cocokkan lewat pemetaan grup (1 grup bisa mewakili
    // beberapa nilai mentah berbeda).
    const statusGroup = (req.query.statusGroup || "").trim();
    if (statusGroup) {
      const statusCol = STATUS_COLUMN[sheetName];
      const headers = await getSheetHeaders(sheetName);
      const resolvedCol = resolveStatusColumn(sheetName, rows, statusCol, headers);
      rows = rows.filter((row) => getStatusGroup(sheetName, row[resolvedCol]) === statusGroup);
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
      if (!v) return;
      values.add(v);
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

// Data khusus untuk halaman "Tree Diagram Progress" MBB: kartu keuangan,
// perbandingan target Juli, breakdown status per region, dan bahan untuk
// grafik Resume/Issue Analytics.
app.get("/api/mbb-tree", async (req, res) => {
  try {
    const allRows = await getSheetData("MBB");
    const headers = await getSheetHeaders("MBB");

    const colAt = (letter) => {
      const idx = colLetterToIndex(letter);
      return idx >= 0 && idx < headers.length ? headers[idx] : null;
    };

    const regionCol = colAt(MBB_REGION_LETTER);
    const poCol = colAt(MBB_PO_LETTER);
    const boqCol = colAt(MBB_BOQ_LETTER);
    const comcaseCol = colAt(MBB_COMCASE_LETTER);
    const juliCol = colAt(MBB_JULI_LETTER);
    const statusColName =
      colAt(STATUS_COLUMN_LETTER.MBB) ||
      resolveStatusColumn("MBB", allRows, STATUS_COLUMN.MBB, headers);

    // Filter opsional: hanya baris yang masuk Target Juli (dipakai khusus
    // untuk panel "RFI Flow — Tree Diagram" waktu toggle "Target Juli"
    // dinyalakan). Tidak mempengaruhi endpoint ini kalau query tidak dikirim.
    const julyOnly = req.query.julyOnly === "1";
    const rows = julyOnly
      ? allRows.filter((row) => {
          const v = juliCol ? String(row[juliCol] || "").toLowerCase() : "";
          return v.includes("juli");
        })
      : allRows;

    function matchStatus(rawValue) {
      const raw = String(rawValue ?? "").trim();
      if (!raw) return "(Kosong)";
      const exact = normalizeStatusText(raw);
      for (const s of MBB_STATUS_ORDER) {
        if (normalizeStatusText(s) === exact) return s;
      }
      const loose = normalizeStatusTextLoose(raw);
      for (const s of MBB_STATUS_ORDER) {
        if (normalizeStatusTextLoose(s) === loose) return s;
      }
      return raw; // status lain di luar funnel utama (mis. Proposed Drop, L0 Drop)
    }

    let totalPO = 0;
    let totalBoQ = 0;
    let totalComcase = 0;
    let targetCount = 0;
    let actualOnAir = 0;

    const statusCounts = {}; // nilai status (sudah dicocokkan) -> jumlah, lintas semua region
    const regionMap = {}; // region -> { total, statuses: {status: count} }
    const issueBTSByRegion = {};
    const l0ReadyByRegion = {};

    rows.forEach((row) => {
      const matched = matchStatus(statusColName ? row[statusColName] : "");
      statusCounts[matched] = (statusCounts[matched] || 0) + 1;

      totalPO += parseRupiahNumber(poCol ? row[poCol] : 0);
      totalBoQ += parseRupiahNumber(boqCol ? row[boqCol] : 0);
      totalComcase += parseRupiahNumber(comcaseCol ? row[comcaseCol] : 0);

      const juliVal = juliCol ? String(row[juliCol] || "").toLowerCase() : "";
      if (juliVal.includes("juli")) {
        targetCount++;
        if (matched === "7. L3. OA Confirmation") actualOnAir++;
      }

      const region = (regionCol ? String(row[regionCol] || "").trim() : "") || "(Tanpa Region)";
      if (!regionMap[region]) regionMap[region] = { region, total: 0, statuses: {} };
      regionMap[region].total++;
      regionMap[region].statuses[matched] = (regionMap[region].statuses[matched] || 0) + 1;

      if (matched === "5.1 L0 Progress - Issue BTS") {
        issueBTSByRegion[region] = (issueBTSByRegion[region] || 0) + 1;
      }
      if (matched === "6. L0 Ready") {
        l0ReadyByRegion[region] = (l0ReadyByRegion[region] || 0) + 1;
      }
    });

    const total = rows.length;
    const onAir = statusCounts["7. L3. OA Confirmation"] || 0;
    const l1ReadyCount = statusCounts["7. L1 Ready"] || 0;
    // "7. L1 Ready" digabung tampilannya jadi 1 dengan "L1 - On Air" (OA
    // Confirmation) di tree diagram, supaya tidak dobel kotak untuk 2 tahap
    // yang secara operasional dianggap 1 fase "L1 - On Air".
    const l1OnAirCombined = onAir + l1ReadyCount;
    const nyOnAir = total - onAir; // baris "0.3 Drop MoM" sudah dibuang lewat ROW_FILTER_RULES
    const drop = 0;

    // "0. HOLD", "0.1 Need Confirm by Tsel", "0.2 Confirmed Batal by Tsel"
    // digabung jadi 1 kartu "Kendala" di tree diagram (bukan 3 kartu
    // terpisah), dan urutan kartu funnel dibalik (tahap paling akhir di
    // atas, "Kendala" di paling bawah) supaya sesuai contoh gambar.
    const KENDALA_STATUSES = ["0. HOLD", "0.1 Need Confirm by Tsel", "0.2 Confirmed Batal by Tsel"];
    const kendalaCount = KENDALA_STATUSES.reduce((sum, s) => sum + (statusCounts[s] || 0), 0);

    const funnelBreakdown = MBB_STATUS_ORDER
      .filter((s) => s !== "7. L3. OA Confirmation" && s !== "7. L1 Ready" && !KENDALA_STATUSES.includes(s))
      .map((s) => ({ status: s, count: statusCounts[s] || 0 }))
      .reverse();
    funnelBreakdown.push({ status: "__KENDALA__", count: kendalaCount });

    res.json({
      total,
      onAir,
      l1ReadyCount,
      l1OnAirCombined,
      nyOnAir,
      drop,
      finance: { po: totalPO, boq: totalBoQ, comcase: totalComcase },
      julyTarget: {
        target: targetCount,
        actual: actualOnAir,
        pct: targetCount > 0 ? Math.round((actualOnAir / targetCount) * 100) : 0,
      },
      statusOrder: MBB_STATUS_ORDER,
      funnelBreakdown,
      regions: Object.values(regionMap).sort((a, b) => b.total - a.total),
      issueBTSByRegion: Object.entries(issueBTSByRegion)
        .map(([region, count]) => ({ region, count }))
        .sort((a, b) => b.count - a.count),
      l0ReadyByRegion: Object.entries(l0ReadyByRegion)
        .map(([region, count]) => ({ region, count }))
        .sort((a, b) => b.count - a.count),
      columnsUsed: {
        region: `${MBB_REGION_LETTER} (${regionCol || "?"})`,
        po: `${MBB_PO_LETTER} (${poCol || "?"})`,
        boq: `${MBB_BOQ_LETTER} (${boqCol || "?"})`,
        comcase: `${MBB_COMCASE_LETTER} (${comcaseCol || "?"})`,
        juli: `${MBB_JULI_LETTER} (${juliCol || "?"})`,
        status: statusColName || "?",
      },
      // Nama kolom mentah (tanpa huruf), dipakai frontend buat sort baris
      // waktu kartu Nilai PO/BoQ/Comcase diklik.
      columnNames: {
        po: poCol || null,
        boq: boqCol || null,
        comcase: comcaseCol || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ambil baris mentah (LOP) yang cocok dengan salah satu kategori di halaman
// "Tree Diagram Progress" MBB — dipakai supaya SEMUA kartu/node di halaman
// itu (root Site ID, cabang L1 On Air/NY On Air/Drop, tiap status funnel,
// tiap sel di tabel pivot region, kartu Resume L0 Ready per Region, dst)
// bisa diklik dan menampilkan daftar LOP aslinya.
//
// Query params:
//   type   = "total" | "onair" | "nyonair" | "drop" | "status" | "region"
//   status = nilai status funnel (dipakai kalau type = "status")
//   region = nama region, BISA digabung dengan type lain sebagai filter
//            tambahan (mis. type=status&status=6.%20L0%20Ready&region=JAKARTA)
app.get("/api/mbb-tree-rows", async (req, res) => {
  try {
    const allRows = await getSheetData("MBB");
    const headers = await getSheetHeaders("MBB");

    const colAt = (letter) => {
      const idx = colLetterToIndex(letter);
      return idx >= 0 && idx < headers.length ? headers[idx] : null;
    };

    const regionCol = colAt(MBB_REGION_LETTER);
    const juliCol = colAt(MBB_JULI_LETTER);
    const statusColName =
      colAt(STATUS_COLUMN_LETTER.MBB) ||
      resolveStatusColumn("MBB", allRows, STATUS_COLUMN.MBB, headers);

    const julyOnly = req.query.julyOnly === "1";
    const rows = julyOnly
      ? allRows.filter((row) => {
          const v = juliCol ? String(row[juliCol] || "").toLowerCase() : "";
          return v.includes("juli");
        })
      : allRows;

    function matchStatus(rawValue) {
      const raw = String(rawValue ?? "").trim();
      if (!raw) return "(Kosong)";
      const exact = normalizeStatusText(raw);
      for (const s of MBB_STATUS_ORDER) {
        if (normalizeStatusText(s) === exact) return s;
      }
      const loose = normalizeStatusTextLoose(raw);
      for (const s of MBB_STATUS_ORDER) {
        if (normalizeStatusTextLoose(s) === loose) return s;
      }
      return raw;
    }

    const KENDALA_STATUSES = ["0. HOLD", "0.1 Need Confirm by Tsel", "0.2 Confirmed Batal by Tsel"];

    const type = String(req.query.type || "total").trim();
    const statusVal = req.query.status ? String(req.query.status) : "";
    const regionVal = req.query.region ? String(req.query.region) : "";

    const filtered = rows.filter((row) => {
      const region = (regionCol ? String(row[regionCol] || "").trim() : "") || "(Tanpa Region)";
      if (regionVal && region !== regionVal) return false;

      if (type === "region") return true; // sudah difilter region di atas
      if (type === "total") return true;

      const matched = matchStatus(statusColName ? row[statusColName] : "");
      if (type === "onair") return matched === "7. L3. OA Confirmation";
      if (type === "onair_combined") return matched === "7. L3. OA Confirmation" || matched === "7. L1 Ready";
      if (type === "nyrfi") return matched !== "7. L3. OA Confirmation" && matched !== "7. L1 Ready";
      if (type === "nyonair") return matched !== "7. L3. OA Confirmation";
      if (type === "drop") return false; // baris drop sudah dibuang total dari data lewat ROW_FILTER_RULES
      if (type === "status") {
        if (statusVal === "__KENDALA__") return KENDALA_STATUSES.includes(matched);
        return matched === statusVal;
      }
      return true;
    });

    const columns = filtered.length > 0 ? Object.keys(filtered[0]) : (rows.length > 0 ? Object.keys(rows[0]) : []);

    res.json({
      type,
      status: statusVal,
      region: regionVal,
      total: filtered.length,
      columns,
      rows: filtered,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CATATAN (NOTES) HALAMAN TREE DIAGRAM MBB
// Menggantikan panel "List L0 Ready Issue BTS per Region". Disimpan di
// file JSON di server (data/mbb-notes.json) supaya SEMUA user yang buka
// dashboard melihat catatan yang sama (shared, bukan per-browser).
//
// CATATAN PENTING: kalau di-deploy ke Railway TANPA Volume, filesystem
// container bersifat sementara (ephemeral) — file ini bisa hilang saat
// redeploy baru. Kalau butuh catatan yang benar-benar permanen lintas
// deploy, tambahkan Railway Volume yang di-mount ke folder `data/`.
// ============================================================
// NOTES_DIR bisa di-override lewat environment variable NOTES_DIR, supaya
// bisa diarahkan ke folder yang di-mount sebagai Railway Volume (folder
// yang TIDAK ikut hilang waktu redeploy). Kalau env var tidak diisi,
// default-nya folder "data" di dalam project (ephemeral di Railway tanpa
// Volume).
const NOTES_DIR = process.env.NOTES_DIR || path.join(__dirname, "data");
const NOTES_FILE = path.join(NOTES_DIR, "mbb-notes.json");

function ensureNotesFile() {
  try {
    if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
    if (!fs.existsSync(NOTES_FILE)) {
      fs.writeFileSync(NOTES_FILE, JSON.stringify({ notes: "", updatedAt: null }, null, 2));
    }
  } catch (e) {
    console.error("Gagal menyiapkan file catatan:", e.message);
  }
}
ensureNotesFile();

app.get("/api/mbb-notes", (req, res) => {
  try {
    ensureNotesFile();
    const data = JSON.parse(fs.readFileSync(NOTES_FILE, "utf-8"));
    res.json(data);
  } catch (err) {
    res.json({ notes: "", updatedAt: null });
  }
});

app.post("/api/mbb-notes", (req, res) => {
  try {
    const notes = String((req.body && req.body.notes) ?? "");
    const data = { notes, updatedAt: new Date().toISOString() };
    ensureNotesFile();
    fs.writeFileSync(NOTES_FILE, JSON.stringify(data, null, 2));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// TULIS BALIK KE GOOGLE SHEETS (UPDATE BARIS LOP DARI WEB)
// ============================================================
// Butuh Service Account Google Cloud (lihat panduan setup di README).
// Kredensialnya disimpan sebagai 1 environment variable:
//   GOOGLE_SERVICE_ACCOUNT_JSON = isi lengkap file credential JSON
// Spreadsheet harus di-share ke email service account itu dengan akses
// "Editor", supaya endpoint ini bisa menulis balik ke sheet aslinya.
// ============================================================

let sheetsClientPromise = null;

function indexToColLetter(idx) {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function invalidateSheetCache(sheetName) {
  cache.lastFetch[sheetName] = 0;
}

// Bikin & cache 1 client Sheets API terautentikasi (dipakai ulang antar
// request, tidak perlu login ulang tiap kali).
function getSheetsClient() {
  if (sheetsClientPromise) return sheetsClientPromise;

  sheetsClientPromise = (async () => {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON belum di-set di environment variable Railway. " +
          "Lihat panduan setup Service Account di README."
      );
    }
    let credentials;
    try {
      credentials = JSON.parse(raw);
    } catch (e) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isinya bukan JSON yang valid: " + e.message);
    }
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
  })();

  // Kalau gagal, jangan cache promise yang reject, supaya request berikutnya
  // bisa coba lagi (mis. kalau env var baru saja ditambahkan lalu di-redeploy).
  sheetsClientPromise.catch(() => {
    sheetsClientPromise = null;
  });

  return sheetsClientPromise;
}

// Cek cepat apakah fitur update sudah siap dipakai (dipanggil frontend
// waktu buka detail LOP, buat nentuin apakah tombol "Simpan Perubahan"
// ditampilkan atau tidak).
app.get("/api/sheets-write-status", async (req, res) => {
  try {
    await getSheetsClient();
    res.json({ ready: true });
  } catch (err) {
    res.json({ ready: false, reason: err.message });
  }
});

// Update 1 baris LOP di SHEET APAPUN berdasarkan SITE ID, langsung ke
// Google Sheets aslinya (bukan cuma cache di server). Dipakai oleh tombol
// "Simpan Perubahan" di halaman detail LOP, berlaku untuk semua sheet
// (MBB, OLO, HEM, FBB, PT2, QE) selama sheet itu punya kolom "SITE ID".
//
// body: { sheet: "MBB", siteId: "...", updates: { "Nama Kolom Persis": "nilai baru", ... } }
app.post("/api/update-row", async (req, res) => {
  try {
    const { sheet, siteId, updates } = req.body || {};
    const sheetName = String(sheet || "").trim().toUpperCase();
    if (!sheetName || !SHEET_NAMES.includes(sheetName)) {
      return res.status(400).json({ error: `Sheet "${sheet}" tidak dikenali. Pilihan: ${SHEET_NAMES.join(", ")}.` });
    }
    if (!siteId || !String(siteId).trim()) {
      return res.status(400).json({ error: "SITE ID wajib diisi untuk tahu baris mana yang diupdate." });
    }
    if (!updates || typeof updates !== "object" || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Tidak ada perubahan yang dikirim." });
    }

    const sheets = await getSheetsClient();

    // Ambil data TERBARU langsung dari Sheets API (bukan cache CSV), supaya
    // nomor baris & posisi kolom akurat waktu ditulis balik.
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:ZZ`,
    });
    const values = getRes.data.values || [];
    if (values.length === 0) {
      return res.status(404).json({ error: `Sheet "${sheetName}" kosong atau tidak ditemukan.` });
    }

    const headerRow = values[0];
    const siteIdColIdx = headerRow.findIndex((h) => normalizeKey(h) === "SITE ID");
    if (siteIdColIdx === -1) {
      return res.status(500).json({ error: `Kolom "SITE ID" tidak ditemukan di baris header sheet ${sheetName}, jadi tidak bisa dipastikan baris mana yang diupdate.` });
    }

    let targetRowIdx = -1; // index di array `values` (0 = header)
    for (let i = 1; i < values.length; i++) {
      if (String((values[i] || [])[siteIdColIdx] || "").trim() === String(siteId).trim()) {
        targetRowIdx = i;
        break;
      }
    }
    if (targetRowIdx === -1) {
      return res.status(404).json({ error: `SITE ID "${siteId}" tidak ditemukan di sheet ${sheetName} (mungkin sudah berubah/dihapus, coba refresh dulu).` });
    }
    const rowNumber = targetRowIdx + 1; // nomor baris asli di spreadsheet (1-based)

    const dataUpdates = [];
    const notFoundColumns = [];
    for (const [colName, newVal] of Object.entries(updates)) {
      const colIdx = headerRow.findIndex((h) => String(h || "").trim() === String(colName).trim());
      if (colIdx === -1) {
        notFoundColumns.push(colName);
        continue;
      }
      dataUpdates.push({
        range: `${sheetName}!${indexToColLetter(colIdx)}${rowNumber}`,
        values: [[newVal === null || newVal === undefined ? "" : String(newVal)]],
      });
    }

    if (dataUpdates.length === 0) {
      return res.status(400).json({ error: "Tidak ada kolom valid untuk diupdate.", notFoundColumns });
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: "USER_ENTERED", data: dataUpdates },
    });

    // Buang cache sheet ini supaya bacaan berikutnya (dashboard, tree, dst)
    // ambil data yang sudah ter-update, bukan versi lama dari cache 1 jam.
    invalidateSheetCache(sheetName);

    res.json({
      success: true,
      sheet: sheetName,
      siteId,
      rowNumber,
      updatedColumns: Object.keys(updates).filter((c) => !notFoundColumns.includes(c)),
      notFoundColumns: notFoundColumns.length ? notFoundColumns : undefined,
    });
  } catch (err) {
    console.error("Gagal update baris:", err);
    res.status(500).json({ error: err.message });
  }
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
      exclusionRuleApplied: ROW_FILTER_RULES[sheetName] || null,
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

// Debug MENTAH: cek apakah ada baris yang JUMLAH KOLOMNYA tidak sama dengan
// jumlah header (indikasi CSV kegeser gara-gara tanda kutip nyasar di sel
// teks panjang seperti RESUME/catatan). Ini baca langsung dari array hasil
// parse CSV, BUKAN dari objek yang sudah dipetakan by name, supaya kelihatan
// kalau ada pergeseran kolom yang "disembunyikan" oleh proses mapping biasa.
app.get("/api/debug-raw/:sheet", async (req, res) => {
  const sheetName = req.params.sheet.toUpperCase();
  if (!SHEET_NAMES.includes(sheetName)) {
    return res.status(404).json({ error: `Sheet "${sheetName}" tidak dikenal.` });
  }
  try {
    const tabName = resolveSheetTabName(sheetName);
    const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
      tabName
    )}`;
    const r = await fetch(url, { redirect: "follow" });
    const csvText = await r.text();
    const rawRows = parse(csvText, {
      skip_empty_lines: false,
      relax_column_count: true,
      trim: true,
    });

    const letter = STATUS_COLUMN_LETTER[sheetName];
    const expectedLetterIndex = letter ? colLetterToIndex(letter) : -1;
    const headerIdx = detectHeaderRowIndex(rawRows, STATUS_COLUMN[sheetName], expectedLetterIndex);
    const headerRow = rawRows[headerIdx];
    const expectedLen = headerRow.length;
    const dataRows = rawRows.slice(headerIdx + 1).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));

    // Hitung berapa baris yang panjangnya BEDA dari header (indikasi kegeser)
    const mismatchedRows = [];
    dataRows.forEach((r, i) => {
      if (r.length !== expectedLen) {
        mismatchedRows.push({ rowIndex: i, length: r.length, expectedLen, valueAtStatusIdx: expectedLetterIndex >= 0 ? r[expectedLetterIndex] : null });
      }
    });

    // Ambil 20 sample nilai MENTAH langsung dari index kolom status (array,
    // bukan objek), supaya kelihatan asli tanpa proses mapping apapun.
    const rawStatusSamples = dataRows.slice(0, 20).map((r, i) => ({
      rowIndex: i,
      rowLength: r.length,
      valueAtStatusIdx: expectedLetterIndex >= 0 ? r[expectedLetterIndex] : null,
    }));

    res.json({
      sheet: sheetName,
      headerIdx,
      expectedLen,
      totalDataRows: dataRows.length,
      statusColumnLetter: letter,
      statusColumnLetterIndex: expectedLetterIndex,
      headerAtStatusIdx: headerRow[expectedLetterIndex],
      mismatchedRowsCount: mismatchedRows.length,
      mismatchedRowsSample: mismatchedRows.slice(0, 10),
      rawStatusSamples,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get("/api/hem-debug", async (req, res) => {
  try {
    const rows = await getSheetData("HEM"); // sudah difilter (exclusion diterapkan)
    const rawRows = (await fetchSheetCSV("HEM")).records; // sebelum difilter
    const headers = await getSheetHeaders("HEM");
    const colBName = headers[1] || null; // kolom B -> index 1
    let coCount = 0;
    rawRows.forEach((r) => {
      const v = String(colBName ? r[colBName] : "").trim();
      const norm = normalizeKey(v);
      if (
        norm.includes(normalizeKey("CO 2025")) ||
        norm.includes(normalizeKey("ADDITIONAL CO"))
      ) {
        coCount++;
      }
    });

    res.json({
      sheet: "HEM",
      totalRowsBeforeFilter: rawRows.length,
      totalRowsAfterFilter: rows.length,
      colBName,
      coCount,
      nonCoCount: rawRows.length - coCount,
      sampleHeaders: headers.slice(0, 12),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});