// Data layer: ingests xtraCHEF "Invoices_*.csv" line-item exports into a JSON
// store and answers queries. The CSV comes from xtraCHEF > Invoices > Download.
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_FILE = path.join(DATA_DIR, "lines.json");
const RAW_DIR = path.join(DATA_DIR, "raw");
export const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads");

// --- CSV parsing (handles quoted fields, embedded commas/newlines) ---
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some(f => f !== "")) rows.push(row); }
  return rows;
}

// Header names in the export -> our field names
const COLMAP = {
  "Location Name": "location",
  "Vendor Name": "vendor",
  "Invoice Number": "invoice_number",
  "Upload Date": "upload_date",
  "Invoice Date": "invoice_date",
  "Invoice Total": "invoice_total",
  "Type": "doc_type",
  "Line Product Item Number": "item_code",
  "Line Description": "description",
  "Line Category": "category",
  "Line GL Code": "gl_code",
  "Line GL Description": "gl_description",
  "Line Quantity": "quantity",
  "Line Unit Price": "unit_price",
  "Line Size": "size",
  "Line Pack": "pack",
  "Line UOM": "uom",
  "Size UOM": "size_uom",
  "Line Total": "line_total",
  "Status": "status",
};
const NUMERIC = new Set(["invoice_total", "quantity", "unit_price", "line_total"]);
const DATES = new Set(["upload_date", "invoice_date"]);

function toIso(mdY) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(mdY || "");
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function lineKey(l) {
  return [l.location, l.vendor, l.invoice_number, l.item_code, l.description, l.quantity, l.unit_price, l.line_total].join("|");
}

export function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); }
  catch { return { lines: [], ingested_files: {}, last_ingest: null }; }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store));
}

export function ingestCsvText(store, text, sourceName) {
  const rows = parseCsv(text);
  if (!rows.length) return { added: 0, skipped: 0, error: "empty file" };
  const header = rows[0];
  if (!header.includes("Line Description") || !header.includes("Invoice Number")) {
    return { added: 0, skipped: 0, error: "not an xtraCHEF invoice line export (missing expected columns)" };
  }
  const idx = {};
  header.forEach((h, i) => { const k = COLMAP[h.trim()]; if (k) idx[k] = i; });
  const existing = new Set(store.lines.map(lineKey));
  let added = 0, skipped = 0;
  for (const row of rows.slice(1)) {
    const line = {};
    for (const [k, i] of Object.entries(idx)) {
      let v = (row[i] ?? "").trim();
      if (NUMERIC.has(k)) v = v === "" ? null : Number(v);
      else if (DATES.has(k)) v = toIso(v);
      line[k] = v;
    }
    if (!line.invoice_number && !line.description) { skipped++; continue; }
    const key = lineKey(line);
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);
    store.lines.push(line);
    added++;
  }
  store.ingested_files[sourceName] = { at: new Date().toISOString(), added };
  store.last_ingest = new Date().toISOString();
  return { added, skipped };
}

export function ingestDownloads({ archive = true } = {}) {
  const store = loadStore();
  const results = [];
  const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => /^Invoices_.*\.csv$/i.test(f));
  for (const f of files) {
    const full = path.join(DOWNLOADS_DIR, f);
    if (store.ingested_files[f]) { results.push({ file: f, status: "already ingested" }); continue; }
    const res = ingestCsvText(store, fs.readFileSync(full, "utf8"), f);
    results.push({ file: f, ...res });
    if (archive && !res.error) {
      fs.mkdirSync(RAW_DIR, { recursive: true });
      fs.copyFileSync(full, path.join(RAW_DIR, f));
    }
  }
  saveStore(store);
  return { files: results, total_lines: store.lines.length };
}

export function ingestFile(filePath) {
  const store = loadStore();
  const name = path.basename(filePath);
  const res = ingestCsvText(store, fs.readFileSync(filePath, "utf8"), name);
  if (!res.error) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.copyFileSync(filePath, path.join(RAW_DIR, name));
  }
  saveStore(store);
  return { file: name, ...res, total_lines: store.lines.length };
}

// --- query helpers ---
function matches(line, f) {
  if (f.location && !(line.location || "").toLowerCase().includes(f.location.toLowerCase())) return false;
  if (f.vendor && !(line.vendor || "").toLowerCase().includes(f.vendor.toLowerCase())) return false;
  if (f.item && !((line.description || "").toLowerCase().includes(f.item.toLowerCase()) || (line.item_code || "") === f.item)) return false;
  if (f.category && !(line.category || "").toLowerCase().includes(f.category.toLowerCase())) return false;
  if (f.invoice_number && line.invoice_number !== f.invoice_number) return false;
  const d = line.invoice_date || line.upload_date;
  if (f.start_date && (!d || d < f.start_date)) return false;
  if (f.end_date && (!d || d > f.end_date)) return false;
  return true;
}

export function queryLines(filters, limit = 200) {
  const store = loadStore();
  const out = store.lines.filter(l => matches(l, filters));
  out.sort((a, b) => (b.invoice_date || "").localeCompare(a.invoice_date || ""));
  return { count: out.length, truncated: out.length > limit, lines: out.slice(0, limit) };
}

export function listInvoices(filters, limit = 100) {
  const store = loadStore();
  const map = new Map();
  for (const l of store.lines) {
    if (!matches(l, filters)) continue;
    const k = `${l.vendor}|${l.invoice_number}|${l.location}`;
    if (!map.has(k)) map.set(k, { vendor: l.vendor, invoice_number: l.invoice_number, location: l.location, invoice_date: l.invoice_date, invoice_total: l.invoice_total, line_count: 0 });
    map.get(k).line_count++;
  }
  const out = [...map.values()].sort((a, b) => (b.invoice_date || "").localeCompare(a.invoice_date || ""));
  return { count: out.length, truncated: out.length > limit, invoices: out.slice(0, limit) };
}

export function priceHistory(item, filters = {}) {
  const { lines } = queryLines({ ...filters, item }, 100000);
  const points = lines
    .filter(l => l.unit_price != null && l.invoice_date)
    .map(l => ({ date: l.invoice_date, vendor: l.vendor, location: l.location, description: l.description, unit_price: l.unit_price, quantity: l.quantity, size: l.size, pack: l.pack, uom: l.uom }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { item, points };
}

export function priceChanges({ min_pct = 5, ...filters } = {}) {
  const store = loadStore();
  const byItem = new Map();
  for (const l of store.lines) {
    if (!matches(l, filters)) continue;
    if (l.unit_price == null || !l.invoice_date || l.doc_type !== "Invoice") continue;
    const k = `${l.vendor}|${l.item_code || l.description}|${l.uom || ""}`;
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(l);
  }
  const changes = [];
  for (const lines of byItem.values()) {
    if (lines.length < 2) continue;
    lines.sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
    const first = lines[0], last = lines[lines.length - 1];
    if (!first.unit_price) continue;
    const pct = ((last.unit_price - first.unit_price) / first.unit_price) * 100;
    if (Math.abs(pct) < min_pct) continue;
    changes.push({
      vendor: last.vendor, item_code: last.item_code, description: last.description, uom: last.uom,
      first_date: first.invoice_date, first_price: first.unit_price,
      last_date: last.invoice_date, last_price: last.unit_price,
      pct_change: Math.round(pct * 10) / 10, purchases: lines.length,
    });
  }
  changes.sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change));
  return { min_pct, count: changes.length, changes: changes.slice(0, 100) };
}

export function spendSummary({ group_by = "vendor", ...filters } = {}) {
  const store = loadStore();
  const keyFn = { vendor: l => l.vendor, category: l => l.category, gl: l => `${l.gl_code} ${l.gl_description}`, location: l => l.location }[group_by];
  if (!keyFn) throw new Error(`group_by must be one of vendor, category, gl, location`);
  const map = new Map();
  for (const l of store.lines) {
    if (!matches(l, filters)) continue;
    if (l.line_total == null) continue;
    const k = keyFn(l) || "(none)";
    map.set(k, (map.get(k) || 0) + l.line_total);
  }
  const groups = [...map.entries()].map(([k, v]) => ({ [group_by]: k, total: Math.round(v * 100) / 100 })).sort((a, b) => b.total - a.total);
  const total = Math.round(groups.reduce((s, g) => s + g.total, 0) * 100) / 100;
  return { group_by, total, groups };
}

export function status() {
  const store = loadStore();
  const dates = store.lines.map(l => l.invoice_date).filter(Boolean).sort();
  const uploads = store.lines.map(l => l.upload_date).filter(Boolean).sort();
  return {
    total_lines: store.lines.length,
    invoice_date_range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    upload_date_range: uploads.length ? { from: uploads[0], to: uploads[uploads.length - 1] } : null,
    locations: [...new Set(store.lines.map(l => l.location))],
    vendors: [...new Set(store.lines.map(l => l.vendor))].length,
    ingested_files: store.ingested_files,
    last_ingest: store.last_ingest,
    refresh_instructions: "xtraCHEF (app.xtrachef.com) > Invoices > set upload-date range > Download. Then run xtrachef_ingest_downloads.",
  };
}
