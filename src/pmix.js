// Product mix: menu-item sales and recipe cost per store, from xtraCHEF's
// Recipe > Product Mix Report > By Item - Summary export (one .xlsx per location).
//
// A scheduled task drops a fresh Washington + Montrose pair into the "Product Mix"
// Drive folder around 4:30 a.m. Central, each covering the 1st of the month through
// yesterday (on the 1st, the whole prior month). This module loads the newest pair
// into pmix.json, which the xtrachef_product_mix tool serves to the dashboard.
// It runs on its own schedule and status file; invoice loading (sync.js) is untouched.
//
// Optional env:  XTRACHEF_PMIX_FOLDER_ID (default: the "Product Mix" folder)
//                XTRACHEF_PMIX_HOURS (Chicago local hours to check, default "5,6,7,8")
//                XTRACHEF_PMIX_ENABLED=false to switch it off (otherwise on whenever
//                XTRACHEF_SYNC_ENABLED=true)
import fs from "fs";
import path from "path";
import zlib from "zlib";
import * as store from "./store.js";
import { composioExecute, localDate, localHour } from "./sync.js";

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const FOLDER_ID = () => env("XTRACHEF_PMIX_FOLDER_ID", "1vw685QiL23v_pXvcerglrmMGdILOwV5v");
const DRIVE_ACCOUNT = () => env("XTRACHEF_DRIVE_ACCOUNT", "googledrive_peba-touch");
const DATA_FILE = () => path.join(store.DATA_DIR, "pmix.json");
const STATUS_FILE = () => path.join(store.DATA_DIR, "pmix-status.json");

// "Washington - Betelgeuse Betelgeuse _PmixByItem_Summary_20261027_053600.xlsx"
const FILE_RE = /^(Washington|Montrose)\b.*_PmixByItem_Summary_(\d{8})_(\d{6})\.xlsx$/i;
export const STORE_KEYS = { washington: "wash", montrose: "mont" };

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const writeJson = (f, obj) => {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(obj));
  fs.renameSync(f + ".tmp", f);
};
export const readData = () => readJson(DATA_FILE());
export const readStatus = () => readJson(STATUS_FILE());

// ---------------------------------------------------------------------------
// Minimal .xlsx reader: first worksheet as an array of rows (no dependencies).
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Error("Not an .xlsx file (no zip directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Error("Corrupt .xlsx zip directory");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    files[name] = () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      if (method === 0) return raw.toString("utf8");
      if (method === 8) return zlib.inflateRawSync(raw).toString("utf8");
      throw Error(`Unsupported zip compression ${method}`);
    };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unxml = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, e, d, h) =>
  d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[e.toLowerCase()]);
const colIndex = (ref) => [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.toUpperCase().charCodeAt(0) - 64, 0) - 1;
const textOf = (xml) => unxml([...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(""));

export function readXlsxRows(buf) {
  const files = unzip(buf);
  const sheetName = Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw Error("No worksheet in .xlsx");
  const shared = files["xl/sharedStrings.xml"] ? [...files["xl/sharedStrings.xml"]().matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1])) : [];
  const rows = [];
  for (const rm of files[sheetName]().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = null;
      if (type === "s") val = shared[Number(v)] ?? null;
      else if (type === "inlineStr") val = textOf(body);
      else if (type === "str" || type === "e") val = v === undefined ? null : unxml(v);
      else if (type === "b") val = v === "1";
      else if (v !== undefined && v !== "") val = Number(v);
      row[ref ? colIndex(ref) : row.length] = val;
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
const ymd = (mdy) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(mdy || ""); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Parse one Product Mix By Item - Summary export into items [name, qty, net, totalCost].
export function parseProductMix(buf) {
  const rows = readXlsxRows(buf);
  const cell = (r) => (r || []).map(v => (v == null ? "" : String(v).trim()));
  const location = cell(rows[0]).find(v => /^Location:/i.test(v))?.replace(/^Location:\s*/i, "") || null;
  const periodText = rows.slice(0, 6).flatMap(cell).find(v => /from\s+\d{2}\/\d{2}\/\d{4}\s+to\s+\d{2}\/\d{2}\/\d{4}/i.test(v));
  const [, from, to] = /from\s+(\S+)\s+to\s+(\S+)/i.exec(periodText || "") || [];
  const h = rows.findIndex(r => { const c = cell(r); return c.includes("Name") && c.includes("Qty Sold"); });
  if (h < 0) throw Error("Product mix export has no 'Name' / 'Qty Sold' header row");
  const head = cell(rows[h]);
  const col = (name) => { const i = head.indexOf(name); if (i < 0) throw Error(`Product mix export is missing the '${name}' column`); return i; };
  const iName = col("Name"), iQty = col("Qty Sold"), iNet = col("Net Sales"), iCost = col("Total Cost");
  const items = [];
  for (const r of rows.slice(h + 1)) {
    const name = r?.[iName] == null ? "" : String(r[iName]).trim();
    if (!name || /^(grand\s+)?total$/i.test(name)) continue;
    items.push([name, round2(r[iQty]), round2(r[iNet]), round2(r[iCost])]);
  }
  return { location, first: ymd(from), last: ymd(to), items };
}

// Newest Washington and Montrose exports in the folder (by the timestamp in the name).
export async function newestPair(opts) {
  const [data] = await composioExecute([{
    tool_slug: "GOOGLEDRIVE_FIND_FILE", account: DRIVE_ACCOUNT(),
    arguments: { folder_id: FOLDER_ID(), q: "name contains 'PmixByItem_Summary' and trashed = false", orderBy: "createdTime desc", pageSize: 50, fields: "files(id,name,size,md5Checksum,createdTime,modifiedTime)" },
  }], opts);
  const pick = {};
  for (const f of data?.files || []) {
    const m = FILE_RE.exec(f.name || "");
    if (!m) continue;
    const key = STORE_KEYS[m[1].toLowerCase()], stamp = m[2] + m[3];
    if (!pick[key] || stamp > pick[key].stamp) pick[key] = { ...f, stamp };
  }
  return pick;
}

async function download(fileId, opts) {
  const [data] = await composioExecute([{ tool_slug: "GOOGLEDRIVE_DOWNLOAD_FILE", account: DRIVE_ACCOUNT(), arguments: { fileId } }], opts);
  const url = data?.downloaded_file_content?.s3url || data?.downloaded_file_content?.url;
  if (!url) throw Error("Drive download returned no file link");
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw Error(`Downloading product mix from Drive returned HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// What the dashboard reads. Stale = the export doesn't reach yesterday.
export function current(now = new Date()) {
  const d = readData(), s = readStatus();
  const yesterday = localDate(new Date(now.getTime() - 86400000));
  const problems = [];
  if (!d) problems.push("No product mix loaded yet.");
  else if (d.last && d.last < yesterday && localHour(now) >= 8) problems.push(`Product mix runs through ${d.last}; expected ${yesterday}.`);
  if (s && s.ok === false) problems.push(`Last product mix load failed ${s.lastAttemptAt}: ${s.error}`);
  return {
    state: problems.length ? "ALERT" : "ok", problems,
    first: d?.first ?? null, last: d?.last ?? null, loaded_at: d?.loadedAt ?? null, files: d?.files ?? null,
    last_attempt_at: s?.lastAttemptAt ?? null,
    source: `Google Drive folder ${FOLDER_ID()} (newest Washington/Montrose *_PmixByItem_Summary_*.xlsx)`,
    wash: d?.wash ?? [], mont: d?.mont ?? [],
  };
}

let running = null;
export function loadNow(opts = {}) {
  if (!running) running = runLoad(opts).finally(() => { running = null; });
  return running;
}

async function runLoad({ force = false, connect } = {}) {
  const prior = readStatus() || {};
  const startedAt = new Date().toISOString();
  try {
    const pair = await newestPair({ connect });
    const missing = ["wash", "mont"].filter(k => !pair[k]);
    if (missing.length) throw Error(`No ${missing.map(k => (k === "wash" ? "Washington" : "Montrose")).join(" or ")} product mix export in the Product Mix Drive folder`);
    const old = readData();
    const same = (k) => old?.files?.[k]?.id === pair[k].id && old?.files?.[k]?.md5 === pair[k].md5Checksum;
    if (!force && same("wash") && same("mont")) {
      writeJson(STATUS_FILE(), { ...prior, ok: true, error: null, lastAttemptAt: startedAt });
      return { ok: true, new_files: false, first: old.first, last: old.last, note: "Newest product mix already loaded" };
    }
    const out = { loadedAt: startedAt, files: {} };
    for (const k of ["wash", "mont"]) {
      const f = pair[k];
      const p = parseProductMix(await download(f.id, { connect }));
      if (!p.items.length) throw Error(`${f.name} has no item rows`);
      out[k] = p.items;
      out.files[k] = { id: f.id, name: f.name, md5: f.md5Checksum, createdTime: f.createdTime, location: p.location, first: p.first, last: p.last, items: p.items.length };
    }
    // Both stores should cover the same days; if not, report the overlap the dashboard can trust.
    out.first = [out.files.wash.first, out.files.mont.first].filter(Boolean).sort().pop() || null;
    out.last = [out.files.wash.last, out.files.mont.last].filter(Boolean).sort()[0] || null;
    writeJson(DATA_FILE(), out);
    const summary = { first: out.first, last: out.last, wash_items: out.wash.length, mont_items: out.mont.length, wash_file: out.files.wash.name, mont_file: out.files.mont.name };
    writeJson(STATUS_FILE(), { ok: true, error: null, lastAttemptAt: startedAt, lastSuccessAt: new Date().toISOString(), last: summary,
      history: [{ at: startedAt, ok: true, last: out.last }, ...(prior.history || [])].slice(0, 30) });
    return { ok: true, new_files: true, ...summary };
  } catch (e) {
    const error = e?.message || String(e);
    writeJson(STATUS_FILE(), { ...prior, ok: false, error, lastAttemptAt: startedAt,
      history: [{ at: startedAt, ok: false, error }, ...(prior.history || [])].slice(0, 30) });
    return { ok: false, error };
  }
}

// Check the folder each listed Chicago hour until today's pair is loaded; also load
// once at startup if nothing is stored yet.
export function startPmixScheduler() {
  if (env("XTRACHEF_SYNC_ENABLED", "") !== "true" || env("XTRACHEF_PMIX_ENABLED", "") === "false") {
    console.error("[xtrachef-pmix] disabled");
    return;
  }
  const hours = env("XTRACHEF_PMIX_HOURS", "5,6,7,8").split(",").map(Number);
  const tick = async () => {
    const now = new Date(), s = readStatus();
    const checkedThisHour = s?.lastAttemptAt && now.getTime() - Date.parse(s.lastAttemptAt) < 55 * 60000;
    if (checkedThisHour) return;
    const loadedToday = s?.ok && s?.lastSuccessAt && localDate(new Date(s.lastSuccessAt)) === localDate(now);
    if (readData() && (!hours.includes(localHour(now)) || loadedToday)) return;
    const r = await loadNow();
    console.error("[xtrachef-pmix]", JSON.stringify(r).slice(0, 500));
  };
  const timer = setInterval(() => void tick(), 5 * 60000);
  timer.unref();
  void tick();
  console.error(`[xtrachef-pmix] enabled, checking Drive at ${hours.join(",")}:00 America/Chicago`);
}
