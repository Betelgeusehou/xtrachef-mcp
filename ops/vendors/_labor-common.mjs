// Shared helpers for the labor (Homebase) and payroll (Toast Payroll) adapters:
// table reading (CSV + a dependency-free XLSX reader), header aliasing, money/hours
// parsing, America/Chicago time math, the 4 AM business-date rule, and FLSA weekly
// overtime. See ops/vendors/LABOR.md.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { parseCsv } from '../../src/store.js';

export { parseCsv };
export const TZ = 'America/Chicago';
export const BUSINESS_DAY_CUTOFF_HOUR = 4; // bars close at 2 AM; a clock-in before 4 AM belongs to the prior business date
export const OT_WEEKLY_THRESHOLD = 40;     // Texas follows federal FLSA: 1.5x over 40 hours in a workweek
export const OT_MULTIPLIER = 1.5;

// ---------------------------------------------------------------- numbers

export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round4 = n => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

// "$1,234.50" -> 1234.5; "(12.00)" -> -12; "" -> null
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s || s === '-' || /^n\/?a$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// "7.5" -> 7.5; "7:30" -> 7.5; "7h 30m" -> 7.5
export function hours(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  let m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (m) return Number(m[1]) + Number(m[2]) / 60 + Number(m[3] || 0) / 3600;
  m = /^(?:(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i.exec(s);
  if (m && (m[1] || m[2])) return Number(m[1] || 0) + Number(m[2] || 0) / 60;
  return num(s);
}

export const stableId = (...parts) => createHash('sha1').update(parts.map(p => String(p ?? '')).join('|')).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- headers

export const normHeader = h => String(h ?? '').replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Build {field: columnIndex} from a header row and {field: [alias, ...]} (aliases compared normalized).
export function mapHeaders(headerRow, aliases) {
  const norm = headerRow.map(normHeader);
  const out = {};
  for (const [field, list] of Object.entries(aliases)) {
    for (const a of list) {
      const i = norm.indexOf(normHeader(a));
      if (i !== -1) { out[field] = i; break; }
    }
  }
  return out;
}

// Find the header row: the first row (within the first 40) matching at least `min` aliased fields.
export function findHeaderRow(rows, aliases, min = 3) {
  let best = { index: -1, cols: {}, score: 0 };
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cols = mapHeaders(rows[i], aliases);
    const score = Object.keys(cols).length;
    if (score >= min && score > best.score) best = { index: i, cols, score };
  }
  return best.index === -1 ? null : best;
}

export const isTotalRow = row => row.some(c => /^(grand\s+)?totals?:?$|^report total|^company total/i.test(String(c).trim()));

// ---------------------------------------------------------------- tables (CSV or XLSX)

export const isZip = buf => buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

// Returns an array of row arrays (strings or numbers) from a CSV or XLSX buffer.
export function readTable(buffer, meta = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (isZip(buf) || /\.xlsx$/i.test(meta.filename || '')) return readXlsx(buf).rows;
  return parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
}

// ---------------------------------------------------------------- minimal ZIP + XLSX reader

// Reads a ZIP via its central directory. Supports stored (0) and deflate (8). Returns Map name -> Buffer.
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw Error('zip: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Error('zip: bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw Error('zip: bad local header');
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw Error(`zip: unsupported compression method ${method} for ${name}`);
  }
  return files;
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENT[e.toLowerCase()]);
const textOf = xml => [...String(xml).matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => unxml(m[1])).join('');
const colIndex = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Parses the first worksheet (or `sheetName`) of an XLSX buffer -> {sheet, sheets, rows}.
export function readXlsx(buf, { sheetName } = {}) {
  const files = readZip(buf);
  const str = n => files.get(n)?.toString('utf8');
  const shared = [];
  const ss = str('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(textOf(m[1]));
  // Resolve sheet name -> part via workbook.xml + its rels; fall back to sheet1.xml.
  const sheets = [];
  const wb = str('xl/workbook.xml') || '';
  const rels = str('xl/_rels/workbook.xml.rels') || '';
  const relTarget = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1], target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) relTarget[id] = target.replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  for (const m of wb.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
    const name = unxml(/\bname="([^"]*)"/.exec(m[1])?.[1] || '');
    const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1];
    sheets.push({ name, part: rid && relTarget[rid] ? `xl/${relTarget[rid]}` : null });
  }
  const chosen = (sheetName && sheets.find(s => s.name === sheetName)) || sheets[0];
  const part = chosen?.part && files.has(chosen.part) ? chosen.part : 'xl/worksheets/sheet1.xml';
  const xml = str(part);
  if (!xml) throw Error('xlsx: worksheet not found');
  const rows = [];
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const r = Number(/\br="(\d+)"/.exec(rm[1])?.[1] || rows.length + 1) - 1;
    const row = [];
    let next = 0;
    for (const cm of rm[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const ci = ref ? colIndex(ref) : next;
      next = ci + 1;
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let val;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(body);
      else if (t === 'str' || t === 'e') val = v === undefined ? '' : unxml(v);
      else if (t === 'b') val = v === '1';
      else val = v === undefined ? '' : Number(v);
      while (row.length < ci) row.push('');
      row[ci] = val;
    }
    while (rows.length < r) rows.push([]);
    rows[r] = row;
  }
  return { sheet: chosen?.name || 'sheet1', sheets: sheets.map(s => s.name), rows: rows.filter(r => r.some(c => c !== '' && c !== null && c !== undefined)) };
}

// Excel serial date -> {date:'YYYY-MM-DD', hour, minute} (1900 date system, wall-clock, no TZ).
export function excelSerial(n) {
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

// ---------------------------------------------------------------- dates and time zones

function partsIn(ms, tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
export function tzOffsetMinutes(ms, tz = TZ) {
  const p = partsIn(ms, tz);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
}
// Wall-clock time in `tz` -> UTC epoch ms (DST-aware).
export function zonedToUtc(date, hour = 0, minute = 0, tz = TZ) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, hour, minute);
  let t = guess - tzOffsetMinutes(guess, tz) * 60000;
  const off2 = tzOffsetMinutes(t, tz);
  t = guess - off2 * 60000;
  return t;
}
// UTC ms -> "2026-11-03T21:00:00-06:00"
export function isoInZone(ms, tz = TZ) {
  const p = partsIn(ms, tz), off = tzOffsetMinutes(ms, tz);
  const pad = n => String(Math.abs(n)).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${off < 0 ? '-' : '+'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}
export function localDateHour(ms, tz = TZ) {
  const p = partsIn(ms, tz);
  return { date: `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, hour: p.h, minute: p.mi };
}
export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Business date for a clock-in: before the 4 AM cutoff it belongs to the previous date.
export function businessDate(msOrIso, tz = TZ, cutoff = BUSINESS_DAY_CUTOFF_HOUR) {
  const ms = typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso);
  if (!Number.isFinite(ms)) return null;
  const { date, hour } = localDateHour(ms, tz);
  return hour < cutoff ? addDays(date, -1) : date;
}
// The UTC window [start, end) covering business dates from..through.
export function businessWindow(from, through, tz = TZ, cutoff = BUSINESS_DAY_CUTOFF_HOUR) {
  return { start: zonedToUtc(from, cutoff, 0, tz), end: zonedToUtc(addDays(through, 1), cutoff, 0, tz) };
}

// "11/03/2026" | "2026-11-03" | "Nov 3, 2026" | "Tue 11/3/26" | Excel serial -> "YYYY-MM-DD"
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return excelSerial(v).date;
  const s = String(v).trim();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const t = Date.parse(s.replace(/^[A-Za-z]{3},?\s+(?=[A-Za-z])/, ''));
  if (Number.isFinite(t)) return new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return null;
}
// "9:00 PM" | "21:00" | "9pm" | "11/03/2026 9:00 PM" | Excel fraction -> {hour, minute, date?}
export function parseTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (v >= 1) { const e = excelSerial(v); return { hour: e.hour, minute: e.minute, date: e.date }; }
    const mins = Math.round(v * 1440);
    return { hour: Math.floor(mins / 60) % 24, minute: mins % 60 };
  }
  const s = String(v).trim();
  const date = /\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/.test(s) ? parseDate(s) : null;
  const rest = date ? s.replace(/^.*?\d{1,4}[-/]\d{1,2}[-/]\d{1,4}[T\s]*/, '') : s;
  const m = /(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?m?\.?/i.exec(rest) || /(\d{1,2}):(\d{2})/.exec(rest);
  if (!m) return date ? { hour: 0, minute: 0, date } : null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  if (m[3]) { const pm = /p/i.test(m[3]); if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12; }
  return { hour, minute, ...(date ? { date } : {}) };
}

// Combine a date column and a clock time column into UTC ms. `after` (ms) rolls a time-only value
// to the next day when it would land before it (overnight clock-outs).
export function combineDateTime(dateStr, timeVal, { tz = TZ, after = null } = {}) {
  const t = parseTime(timeVal);
  if (!t) return null;
  const d = t.date || dateStr;
  if (!d) return null;
  let ms = zonedToUtc(d, t.hour, t.minute, tz);
  if (after !== null && !t.date) while (ms <= after) ms = zonedToUtc(addDays(localDateHour(ms, tz).date, 1), t.hour, t.minute, tz);
  return ms;
}

// ---------------------------------------------------------------- overtime

// Monday-start (configurable) workweek containing a business date.
export function workweekStart(date, weekStart = 1) {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow - weekStart + 7) % 7));
}

// Splits hours into regular/OT per employee per FLSA workweek, chronologically by clock_in.
// Mutates and returns `shifts`. Salaried rows (extra.salaried) are exempt and skipped.
// Each shift needs: employee, business_date, clock_in, paid hours in `extra.paid_hours`, wage_rate.
export function computeWeeklyOvertime(shifts, { weekStart = 1, threshold = OT_WEEKLY_THRESHOLD, multiplier = OT_MULTIPLIER } = {}) {
  const groups = new Map();
  for (const s of shifts) {
    if (s.extra?.salaried) continue;
    const key = `${s.extra?.employee_key || s.employee}|${workweekStart(s.business_date, weekStart)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
    let worked = 0;
    for (const s of list) {
      const paid = s.extra.paid_hours || 0;
      const reg = Math.max(0, Math.min(paid, threshold - worked));
      worked += paid;
      s.regular_hours = round4(reg);
      s.ot_hours = round4(paid - reg);
      s.extra.ot_computed = true;
      s.extra.workweek_start = workweekStart(s.business_date, weekStart);
      if (Number.isFinite(s.wage_rate)) {
        if (s.labor_cost !== null && s.labor_cost !== undefined) s.extra.source_labor_cost = s.labor_cost;
        s.labor_cost = round2(s.regular_hours * s.wage_rate + s.ot_hours * s.wage_rate * multiplier);
      }
    }
  }
  return shifts;
}

// Keep only records whose business_date is in [from, through].
export const inRange = (recs, range) => !range ? recs : recs.filter(r => (!range.from || r.business_date >= range.from) && (!range.through || r.business_date <= range.through));

// Pull the first array found under common wrapper keys (internal JSON shapes vary).
export function arrayIn(json, keys = ['data', 'results', 'items', 'records']) {
  if (Array.isArray(json)) return json;
  for (const k of keys) if (Array.isArray(json?.[k])) return json[k];
  for (const k of keys) if (json?.[k] && typeof json[k] === 'object') { const a = arrayIn(json[k], keys); if (a.length) return a; }
  return [];
}
// First defined value among candidate keys (supports snake_case and camelCase variants).
export function pick(obj, ...keys) {
  for (const k of keys) {
    for (const v of [k, k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]) {
      const val = v.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);
      if (val !== undefined && val !== null && val !== '') return val;
    }
  }
  return undefined;
}
