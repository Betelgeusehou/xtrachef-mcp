// Shared helpers for the delivery adapters (DoorDash, Uber Eats, Grubhub).
//
// The three adapters all work the same way: every source row (a CSV row object
// or a JSON item from a portal endpoint) is flattened into a map keyed by a
// normalized header name, a vendor-specific mapper reads fields through alias
// lists, and finalizeOrders/finalizePayouts here turn those partial rows into
// normalized delivery_orders / delivery_payouts records (see ops/README.md).
import { parseCsv } from '../../src/store.js';
import { canonicalStore } from '../core/stores.mjs';

export const TZ = 'America/Chicago';
// Betelgeuse closes at 2am. Anything placed before 04:00 local belongs to the
// previous business date.
export const BUSINESS_DAY_CUTOFF_HOUR = 4;

// ---------------------------------------------------------------- headers --

// "Subtotal tax passed to merchant" / "subtotal_tax_passed_to_merchant" /
// "subtotalTaxPassedToMerchant" all become "subtotaltaxpassedtomerchant".
export function normHeader(h) {
  return String(h ?? '').replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9%]/g, '').replace(/%/g, 'pct');
}

// ------------------------------------------------------------------ money --

// "$1,234.56" -> 1234.56, "(12.00)" -> -12, "-12.00" -> -12, "" -> null.
export function money(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : null;
  if (typeof v === 'object') return moneyObject(v);
  let s = String(v).trim();
  if (!s || /^(n\/?a|null|none|-|—)$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$\s,]|USD/gi, '');
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return round2(neg ? -n : n);
}

// JSON money shapes seen in web portals: {unit_amount|amount, currency, decimal_places},
// {units, nanos}, {amountE5}, {amount_cents}. Returns dollars or null.
export function moneyObject(o) {
  if (!o || typeof o !== 'object') return null;
  const k = Object.fromEntries(Object.entries(o).map(([key, val]) => [normHeader(key), val]));
  if (k.amounte5 !== undefined) return round2(Number(k.amounte5) / 1e5);
  if (k.units !== undefined) return round2(Number(k.units) + Number(k.nanos || 0) / 1e9);
  if (k.amountcents !== undefined) return round2(Number(k.amountcents) / 100);
  const unit = k.unitamount ?? k.amount ?? k.value;
  if (unit !== undefined) {
    if (typeof unit === 'string') return money(unit);
    const dp = k.decimalplaces ?? (k.unitamount !== undefined ? 2 : 0);
    return round2(Number(unit) / 10 ** Number(dp));
  }
  if (k.displaystring !== undefined) return money(k.displaystring);
  return null;
}
const MONEY_KEYS = new Set(['amounte5', 'units', 'nanos', 'amountcents', 'unitamount', 'amount', 'currency', 'currencycode', 'decimalplaces', 'displaystring', 'value']);
const isMoneyObject = o => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0
  && Object.keys(o).every(key => MONEY_KEYS.has(normHeader(key)))
  && Object.keys(o).some(key => ['amounte5', 'units', 'amountcents', 'unitamount', 'amount', 'value'].includes(normHeader(key)));

export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const abs2 = n => (n === null || n === undefined ? null : round2(Math.abs(n)));
export const sum2 = (...xs) => round2(xs.reduce((a, x) => a + (Number(x) || 0), 0));

// ------------------------------------------------------------------ dates --

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');

// Accepts "2026-11-03", "11/03/2026", "11/3/26", "Nov 3, 2026", "2026-11-03T01:20:00",
// "2026-11-03 01:20:00". Returns {y,m,d} or null. Time part (if any) is ignored here.
export function parseDateParts(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return { y: +m[1], m: +m[2], d: +m[3] };
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) return { y: +m[3] < 100 ? 2000 + +m[3] : +m[3], m: +m[1], d: +m[2] };
  if ((m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})/))) {
    const mon = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return { y: +m[3], m: mon, d: +m[2] };
  }
  return null;
}

// "01:20", "1:20 AM", "13:05:59", "2026-11-03 01:20:00", "2026-11-03T01:20:00" -> {h,mi,s}
export function parseTimeParts(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  const m = s.match(/(?:^|[T\s])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp]\.?[Mm]\.?)?/) || s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/);
  if (!m) return null;
  let h = +m[1];
  const ap = m[4]?.toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { h, mi: +m[2], s: +(m[3] || 0) };
}

export const ymd = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Wall-clock parts of an instant in America/Chicago.
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function chicagoParts(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// Chicago wall time -> UTC ISO string (handles CST/CDT).
export function chicagoToIso({ y, m, d }, { h = 0, mi = 0, s = 0 } = {}) {
  const want = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = want + 6 * 3600e3;
  for (let i = 0; i < 3; i++) {
    const p = chicagoParts(new Date(guess));
    const got = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    if (got === want) break;
    guess += want - got;
  }
  return new Date(guess).toISOString();
}

// The business-date rule. Takes Chicago wall-clock date + time.
export function businessDate(dateParts, timeParts) {
  const d = ymd(dateParts);
  if (timeParts && timeParts.h < BUSINESS_DAY_CUTOFF_HOUR) return addDays(d, -1);
  return d;
}

// Resolve an order's timing from whatever the source gives. Prefers local wall
// time (what the portals show), falls back to a UTC/offset timestamp.
//   {localDate, localTime, utc}  -> {business_date, placed_at, local}
export function resolveTime({ localDate, localTime, utc } = {}) {
  let dp = parseDateParts(localDate);
  let tp = parseTimeParts(localTime) || (dp ? parseTimeParts(localDate) : null);
  if (!dp && utc !== null && utc !== undefined && utc !== '') {
    const t = typeof utc === 'number' ? new Date(utc > 1e12 ? utc : utc * 1000) : new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(utc)) ? utc : String(utc).replace(' ', 'T') + 'Z');
    if (!Number.isNaN(t.getTime())) {
      const p = chicagoParts(t);
      dp = { y: p.y, m: p.m, d: p.d };
      tp = { h: p.h, mi: p.mi, s: p.s };
    }
  }
  if (!dp) return { business_date: null, placed_at: null };
  return {
    business_date: businessDate(dp, tp),
    placed_at: chicagoToIso(dp, tp || { h: 12 }),
    local: `${ymd(dp)}${tp ? ` ${pad(tp.h)}:${pad(tp.mi)}:${pad(tp.s)}` : ''}`,
  };
}

export const toDate = v => { const p = parseDateParts(v); return p ? ymd(p) : null; };

// -------------------------------------------------------------- row access --

// Flatten a CSV row object or a nested JSON item into {normalizedKey: value}.
// Nested keys are joined (store.name -> "storename") and also kept under their
// leaf name when that leaf isn't already taken; money objects become dollars.
export function flatten(obj, prefix = '', out = {}) {
  if (obj instanceof Map) obj = Object.fromEntries(obj);
  for (const [k, v] of Object.entries(obj || {})) {
    const key = normHeader(prefix + k);
    const leaf = normHeader(k);
    if (isMoneyObject(v)) {
      const n = moneyObject(v);
      out[key] = n;
      if (!(leaf in out)) out[leaf] = n;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, prefix + k + '_', out);
    } else {
      if (!(key in out) || out[key] === '' || out[key] === null) out[key] = v;
      if (prefix && !(leaf in out)) out[leaf] = v;
    }
  }
  return out;
}

// Accessor over a flattened row. Every lookup takes an alias list and returns
// the first alias that is present and non-empty.
export function getter(row) {
  const r = row && row.__flat ? row : flatten(row);
  const find = aliases => {
    for (const a of [].concat(aliases)) {
      const k = normHeader(a);
      if (k in r && r[k] !== '' && r[k] !== null && r[k] !== undefined) return { key: k, value: r[k] };
    }
    return null;
  };
  return {
    row: r,
    has: aliases => !!find(aliases),
    raw: aliases => find(aliases)?.value ?? null,
    str: aliases => { const f = find(aliases); return f ? String(f.value).trim() : null; },
    // Money. Aliases ending in "cents" are divided by 100.
    num: aliases => {
      for (const a of [].concat(aliases)) {
        const f = find(a);
        if (!f) continue;
        const n = money(f.value);
        if (n === null) continue;
        return /cents$/.test(f.key) && typeof f.value !== 'object' ? round2(n / 100) : n;
      }
      return null;
    },
  };
}

// ------------------------------------------------------------------ CSV in --

// Parse CSV text into objects keyed by normalized header. The header row is the
// first row (within the first 15) where at least `minHits` cells are known
// aliases, so title rows / description rows above it are skipped.
export function csvRows(input, knownHeaders, { minHits = 3 } = {}) {
  let text = Buffer.isBuffer(input) ? decode(input) : String(input ?? '');
  text = text.replace(/^﻿/, '');
  const rows = parseCsv(text);
  const known = new Set([...knownHeaders].map(normHeader));
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const hits = rows[i].filter(c => known.has(normHeader(c))).length;
    if (hits >= minHits) { hi = i; break; }
  }
  if (hi < 0) return { headers: [], rows: [] };
  const headers = rows[hi].map(normHeader);
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(c => String(c).trim() === '')) continue;
    // a repeated header row (multi-store exports concatenated) -> skip
    if (r.map(normHeader).join('|') === headers.join('|')) continue;
    const o = { __flat: true, __line: i + 1 };
    headers.forEach((h, j) => { if (h && !(h in o && o[h] !== '')) o[h] = r[j] ?? ''; });
    out.push(o);
  }
  return { headers, rows: out };
}

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1);
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf); b.swap16(); return b.toString('utf16le').slice(1); }
  return buf.toString('utf8');
}

// ----------------------------------------------------------------- output --

// Every parse/collect result is {delivery_orders, delivery_payouts} plus a
// non-enumerable `stats` property ({rows, skipped_store, skipped_other, ...})
// so ops/core/store.upsertResult only sees record kinds.
export function emptyResult() {
  const res = { delivery_orders: [], delivery_payouts: [] };
  Object.defineProperty(res, 'stats', { value: { rows: 0, orders: 0, payouts: 0, skipped_store: 0, skipped_other: 0, unmapped_stores: [], warnings: 0 }, enumerable: false, writable: true });
  return res;
}
export function mergeResults(into, from) {
  into.delivery_orders.push(...from.delivery_orders);
  into.delivery_payouts.push(...from.delivery_payouts);
  for (const [k, v] of Object.entries(from.stats || {})) {
    if (Array.isArray(v)) into.stats[k] = [...new Set([...(into.stats[k] || []), ...v])];
    else if (typeof v === 'number') into.stats[k] = (into.stats[k] || 0) + v;
  }
  return into;
}

const ORDER_MONEY = ['subtotal', 'tax', 'tip', 'commission', 'processing_fee', 'marketing_fee', 'adjustments', 'error_charges', 'payout'];

// Sign conventions on output (vendors differ, so mappers hand over raw signed
// numbers and this normalizes): fees and error charges are positive costs;
// adjustments are signed (+ = money to the restaurant); payout is signed.
//   payout ≈ subtotal + tax + tip - commission - processing_fee - marketing_fee - error_charges + adjustments
export function expectedPayout(o) {
  return round2((o.subtotal || 0) + (o.tax || 0) + (o.tip || 0) - (o.commission || 0) - (o.processing_fee || 0)
    - (o.marketing_fee || 0) - (o.error_charges || 0) + (o.adjustments || 0));
}

// partials: [{order_id, store_label, time:{localDate,localTime,utc}, status, channel,
//            subtotal, tax, tip, commission, processing_fee, marketing_fee, adjustments,
//            error_charges, payout, payout_id, payout_date, row_type, extra, line}]
// Rows for the same order (e.g. a DELIVERY row and a later ERROR_CHARGE row) are summed.
export function finalizeOrders(vendor, partials, res = emptyResult(), { reconcile = true } = {}) {
  const byId = new Map();
  for (const p of partials) {
    res.stats.rows++;
    const store = canonicalStore(p.store_label);
    if (!store) {
      res.stats.skipped_store++;
      if (p.store_label && !res.stats.unmapped_stores.includes(p.store_label)) res.stats.unmapped_stores.push(p.store_label);
      continue;
    }
    if (!p.order_id) { res.stats.skipped_other++; continue; }
    const t = resolveTime(p.time);
    const warnings = [];
    if (!t.business_date) warnings.push(`no parseable order timestamp${p.line ? ` (line ${p.line})` : ''}`);
    const rec = {
      vendor, store, business_date: t.business_date, order_id: String(p.order_id), placed_at: t.placed_at,
      status: p.status || null, channel: p.channel || null,
      subtotal: p.subtotal ?? null, tax: p.tax ?? null, tip: p.tip ?? null,
      commission: abs2(p.commission), processing_fee: abs2(p.processing_fee), marketing_fee: p.marketing_fee ?? null,
      adjustments: p.adjustments ?? null, error_charges: abs2(p.error_charges), payout: p.payout ?? null,
      extra: { ...(p.extra || {}), local_time: t.local, payout_id: p.payout_id || undefined, payout_date: toDate(p.payout_date) || undefined, row_types: p.row_type ? [p.row_type] : undefined, warnings },
    };
    const prev = byId.get(rec.order_id);
    if (!prev) { byId.set(rec.order_id, rec); continue; }
    // merge: sum money, keep the earliest timestamp's timing + the order row's status
    for (const k of ORDER_MONEY) if (rec[k] !== null) prev[k] = round2((prev[k] || 0) + rec[k]);
    if (rec.placed_at && (!prev.placed_at || rec.placed_at < prev.placed_at) && isOrderRowType(rec.extra.row_types?.[0])) {
      prev.placed_at = rec.placed_at; prev.business_date = rec.business_date; prev.extra.local_time = rec.extra.local_time;
    }
    if (!prev.business_date) { prev.business_date = rec.business_date; prev.placed_at = rec.placed_at; }
    if (isOrderRowType(rec.extra.row_types?.[0]) && rec.status) prev.status = rec.status;
    prev.channel ||= rec.channel;
    if (prev.store !== rec.store) prev.extra.warnings.push(`rows for this order name different stores (${prev.store}, ${rec.store})`);
    prev.extra.row_types = [...(prev.extra.row_types || []), ...(rec.extra.row_types || [])];
    prev.extra.payout_id ||= rec.extra.payout_id;
    prev.extra.payout_date ||= rec.extra.payout_date;
    prev.extra.warnings.push(...rec.extra.warnings);
    prev.extra.merged_rows = (prev.extra.merged_rows || 1) + 1;
  }
  for (const rec of byId.values()) {
    if (reconcile && rec.payout !== null && rec.subtotal !== null) {
      const diff = round2(rec.payout - expectedPayout(rec));
      if (Math.abs(diff) > 0.01) rec.extra.warnings.push(`payout differs from subtotal+tax+tip-fees+adjustments by ${diff.toFixed(2)}`);
    }
    if (rec.payout !== null && rec.payout < 0 && !rec.extra.row_types?.some(t => /adjust|error|refund|ad_fee|fee/i.test(t || ''))) rec.extra.warnings.push('negative payout');
    cleanExtra(rec.extra);
    if (rec.extra.warnings?.length) res.stats.warnings++;
    if (!rec.business_date) { res.stats.skipped_other++; res.stats.warnings++; continue; }
    res.delivery_orders.push(rec);
    res.stats.orders++;
  }
  return res;
}
const isOrderRowType = t => !t || (!/error|adjust|refund|fee|credit|cancel/i.test(t) && /deliver|order|pickup|complete|prepaid|sale/i.test(t));

// partials: [{payout_id, store_label, payout_date, period_start, period_end, gross_sales,
//            total_fees, adjustments, net_payout, extra, line}]
export function finalizePayouts(vendor, partials, res = emptyResult()) {
  const byId = new Map();
  for (const p of partials) {
    res.stats.rows++;
    const store = canonicalStore(p.store_label);
    if (!store) {
      res.stats.skipped_store++;
      if (p.store_label && !res.stats.unmapped_stores.includes(p.store_label)) res.stats.unmapped_stores.push(p.store_label);
      continue;
    }
    if (!p.payout_id) { res.stats.skipped_other++; continue; }
    const warnings = [];
    const rec = {
      vendor, store, payout_id: String(p.payout_id), payout_date: toDate(p.payout_date),
      period_start: toDate(p.period_start), period_end: toDate(p.period_end),
      gross_sales: p.gross_sales ?? null, total_fees: abs2(p.total_fees), adjustments: p.adjustments ?? null, net_payout: p.net_payout ?? null,
      extra: { ...(p.extra || {}), warnings },
    };
    if (!rec.payout_date) warnings.push(`no payout date${p.line ? ` (line ${p.line})` : ''}`);
    const prev = byId.get(rec.payout_id);
    if (prev) { // payout ids are per store; the same id on two rows -> sum
      for (const k of ['gross_sales', 'total_fees', 'adjustments', 'net_payout']) if (rec[k] !== null) prev[k] = round2((prev[k] || 0) + rec[k]);
      prev.period_start = [prev.period_start, rec.period_start].filter(Boolean).sort()[0] || null;
      prev.period_end = [prev.period_end, rec.period_end].filter(Boolean).sort().at(-1) || null;
      continue;
    }
    byId.set(rec.payout_id, rec);
  }
  for (const rec of byId.values()) {
    if (rec.gross_sales !== null && rec.net_payout !== null && rec.total_fees !== null) {
      const diff = round2(rec.net_payout - (rec.gross_sales - rec.total_fees + (rec.adjustments || 0)));
      if (Math.abs(diff) > 0.01) rec.extra.warnings.push(`net_payout differs from gross_sales-total_fees+adjustments by ${diff.toFixed(2)}`);
    }
    cleanExtra(rec.extra);
    if (rec.extra.warnings?.length) res.stats.warnings++;
    if (!rec.payout_date) { res.stats.skipped_other++; continue; }
    res.delivery_payouts.push(rec);
    res.stats.payouts++;
  }
  return res;
}

// Build payouts from order rows that carry a payout id (Uber Eats payment
// details, Grubhub transactions). Flagged derived_from_orders: a file covering
// only part of a payout period gives a partial payout until a fuller file lands.
// `others` = non-order rows that still belong to a payout (ad spend, credits):
// [{payout_id, store, payout_date, amount}] -> counted as adjustments.
export function derivePayouts(vendor, orders, others = []) {
  const groups = new Map();
  for (const x of others) {
    if (!x.payout_id || !x.store) continue;
    const g = groups.get(x.payout_id) || { payout_id: x.payout_id, store_label: x.store, payout_date: toDate(x.payout_date), dates: [], gross_sales: 0, total_fees: 0, adjustments: 0, net_payout: 0, orders: 0 };
    g.adjustments += x.amount || 0;
    g.net_payout += x.amount || 0;
    groups.set(x.payout_id, g);
  }
  for (const o of orders) {
    const id = o.extra?.payout_id;
    if (!id) continue;
    const g = groups.get(id) || { payout_id: id, store_label: o.store, payout_date: o.extra.payout_date, dates: [], gross_sales: 0, total_fees: 0, adjustments: 0, net_payout: 0, orders: 0 };
    g.payout_date ||= o.extra.payout_date;
    g.dates.push(o.business_date);
    g.gross_sales += (o.subtotal || 0) + (o.tax || 0) + (o.tip || 0);
    g.total_fees += (o.commission || 0) + (o.processing_fee || 0) + (o.marketing_fee || 0);
    g.adjustments += (o.adjustments || 0) - (o.error_charges || 0);
    g.net_payout += o.payout || 0;
    g.orders++;
    groups.set(id, g);
  }
  return [...groups.values()].map(g => ({
    payout_id: g.payout_id, store_label: g.store_label, payout_date: g.payout_date,
    period_start: g.dates.sort()[0] || null, period_end: g.dates.at(-1) || null,
    gross_sales: round2(g.gross_sales), total_fees: round2(g.total_fees), adjustments: round2(g.adjustments), net_payout: round2(g.net_payout),
    extra: { derived_from_orders: true, order_count: g.orders },
  }));
}

function cleanExtra(e) {
  for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === null || (Array.isArray(e[k]) && !e[k].length)) delete e[k];
}

// ---------------------------------------------------------- matchFile help --

export function senderDomain(from) {
  const m = String(from || '').toLowerCase().match(/@([a-z0-9.-]+)/);
  return m ? m[1] : '';
}
export const fromDomain = (from, domains) => {
  const d = senderDomain(from);
  return !!d && domains.some(x => d === x || d.endsWith('.' + x));
};
export const isTabular = meta => /\.(csv|txt)$/i.test(meta?.filename || '') || /csv|text\/plain|comma-separated/i.test(meta?.mimeType || '');

// ------------------------------------------------------- session-mode help --

export class ShapeError extends Error {
  constructor(msg) { super(`endpoint shape changed: ${msg}`); this.name = 'ShapeError'; this.shapeChanged = true; }
}

// Read a dotted path out of a JSON response; first path that exists wins.
export function dig(obj, paths) {
  for (const p of [].concat(paths)) {
    let cur = obj;
    for (const part of p.split('.')) { if (cur === null || cur === undefined) break; cur = cur[part]; }
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}
export function requireArray(obj, paths, label) {
  const v = dig(obj, paths);
  if (!Array.isArray(v)) throw new ShapeError(`missing ${label} (looked for ${[].concat(paths).join(' | ')})`);
  return v;
}

// Every date in [from, through], chunked into windows of at most `days`.
export function dateWindows(range, days) {
  if (!range?.from || !range?.through) throw Error('range {from, through} required');
  const out = [];
  for (let s = range.from; s <= range.through; s = addDays(s, days)) {
    const e = addDays(s, days - 1);
    out.push({ from: s, through: e < range.through ? e : range.through });
  }
  return out;
}

// Query string from an object, dropping undefined.
export const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();

// Fill "{from}" style placeholders.
export const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));

// Common UI-download fallback: run `trigger(page)` (clicks that start a
// download), wait for the download, read it into a Buffer.
export async function downloadVia(page, trigger, { timeout = 180_000 } = {}) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout }), trigger(page)]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return { buffer: Buffer.concat(chunks), filename: download.suggestedFilename() };
}

// Session-mode wrapper: try the JSON endpoints, and if they fail drive the UI
// to download the CSV for the range. If both fail, throw the API error (with a
// shapeChanged flag when that was the cause) so the runner falls back to inbox.
export async function collectWithFallback(ctx, range, { viaApi, viaUi, vendor }) {
  try {
    return await viaApi();
  } catch (apiErr) {
    ctx.log?.(`${vendor}: JSON endpoints failed (${apiErr.message}); trying report download in the UI`);
    try {
      const res = await viaUi();
      res.stats.fallback = 'ui_download';
      return res;
    } catch (uiErr) {
      const e = new Error(`${apiErr.message}; UI download fallback also failed: ${uiErr.message}`);
      e.shapeChanged = !!apiErr.shapeChanged;
      e.cause = apiErr;
      throw e;
    }
  }
}

// Replace "{name}" placeholders inside a JSON body template. A string that is
// exactly "{name}" takes the raw value (numbers stay numbers).
export function fillDeep(tpl, vars) {
  if (typeof tpl === 'string') {
    const whole = tpl.match(/^\{(\w+)\}$/);
    if (whole) return vars[whole[1]];
    return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
  }
  if (Array.isArray(tpl)) return tpl.map(x => fillDeep(x, vars));
  if (tpl && typeof tpl === 'object') return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fillDeep(v, vars)]));
  return tpl;
}

// Generic paginator over a portal JSON endpoint described by an ENDPOINTS entry:
//   { label, method, url, body, headers, itemsPath, cursorPath, pageSize, firstPage }
// cursorPath -> cursor pagination ({cursor}); otherwise page/offset pagination
// ({page}, {offset}, {limit}) stopping on a short page.
export async function paginate(ctx, spec, vars = {}, { maxPages = 200 } = {}) {
  const items = [];
  let cursor = '';
  let page = spec.firstPage ?? 0;
  for (let i = 0; i < maxPages; i++) {
    const v = { ...vars, cursor, page, offset: items.length, limit: spec.pageSize ?? '' };
    const url = fill(spec.url, v);
    const headers = { accept: 'application/json', ...(spec.headers || {}) };
    const init = spec.method && spec.method !== 'GET'
      ? { method: spec.method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(fillDeep(spec.body || {}, v)) }
      : { method: 'GET', headers };
    const json = await ctx.api(url, init);
    if (json === null || typeof json !== 'object') throw new ShapeError(`${spec.label}: response is not JSON`);
    const batch = requireArray(json, spec.itemsPath, spec.label);
    items.push(...batch);
    if (spec.cursorPath) {
      const next = dig(json, spec.cursorPath);
      if (!next || !batch.length || next === cursor) break;
      cursor = String(next);
    } else if (spec.pageSize) {
      if (batch.length < spec.pageSize) break;
      page++;
    } else break;
  }
  return items;
}

// Drive a portal's report UI to produce and download a CSV for the range.
// sel = { reportsUrl, steps: [{click}|{fill, value}|{select, value}|{waitFor}], download, maxWaitMs, pollMs }
// Reports generated asynchronously are polled: reload, look for the download
// control, repeat until maxWaitMs.
export async function runUiDownload(page, sel, range) {
  if (!page) throw Error('no page in ctx');
  const vars = { from: range.from, through: range.through, from_us: usDate(range.from), through_us: usDate(range.through) };
  await page.goto(sel.reportsUrl, { waitUntil: 'domcontentloaded' });
  for (const step of sel.steps || []) {
    if (step.waitFor) await page.locator(step.waitFor).first().waitFor({ timeout: 30_000 });
    if (step.click) await page.locator(step.click).first().click({ timeout: 30_000 });
    if (step.fill) await page.locator(step.fill).first().fill(fillDeep(step.value, vars), { timeout: 30_000 });
    if (step.select) await page.locator(step.select).first().selectOption(fillDeep(step.value, vars), { timeout: 30_000 });
  }
  const deadline = Date.now() + (sel.maxWaitMs ?? 300_000);
  for (;;) {
    const btn = page.locator(sel.download).first();
    if (await btn.count().catch(() => 0)) return downloadVia(page, () => btn.click());
    if (Date.now() > deadline) throw Error(`report download control not found (${sel.download})`);
    await page.waitForTimeout(sel.pollMs ?? 15_000);
    if (sel.reloadWhilePolling !== false) await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
const usDate = d => { const [y, m, dd] = d.split('-'); return `${m}/${dd}/${y}`; };

export async function urlLooksLoggedIn(ctx, { host, loginPatterns, shellSelector }) {
  const page = ctx.page;
  if (!page) return false;
  let url;
  try { url = new URL(page.url()); } catch { return false; }
  if (!url.hostname.endsWith(host)) return false;
  if (loginPatterns.some(re => re.test(url.href))) return false;
  if (!shellSelector) return true;
  try { return (await page.locator(shellSelector).count()) > 0; } catch { return false; }
}
