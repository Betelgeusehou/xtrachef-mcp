// Normalized ops store (SQLite, node:sqlite). One table per record kind; see ops/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const opsDir = () => process.env.OPS_DATA_DIR || path.join(process.env.XTRACHEF_DATA_DIR || '/data', 'ops');

// kind -> { key: natural-key columns, cols: all columns (besides vendor-agnostic meta) }
export const KINDS = {
  delivery_orders: {
    key: ['vendor', 'order_id'],
    cols: ['vendor', 'store', 'business_date', 'order_id', 'placed_at', 'status', 'subtotal', 'tax', 'tip', 'commission', 'processing_fee', 'marketing_fee', 'adjustments', 'error_charges', 'payout', 'channel'],
  },
  delivery_payouts: {
    key: ['vendor', 'payout_id'],
    cols: ['vendor', 'store', 'payout_id', 'payout_date', 'period_start', 'period_end', 'gross_sales', 'total_fees', 'adjustments', 'net_payout'],
  },
  labor_shifts: {
    key: ['vendor', 'shift_id'],
    cols: ['vendor', 'store', 'shift_id', 'business_date', 'employee', 'role', 'clock_in', 'clock_out', 'regular_hours', 'ot_hours', 'wage_rate', 'labor_cost', 'tips_declared'],
  },
  schedule_shifts: {
    key: ['vendor', 'shift_id'],
    cols: ['vendor', 'store', 'shift_id', 'business_date', 'employee', 'role', 'start', 'end', 'scheduled_hours', 'scheduled_cost'],
  },
  payroll_runs: {
    key: ['vendor', 'run_id'],
    cols: ['vendor', 'store', 'run_id', 'pay_date', 'period_start', 'period_end', 'gross_wages', 'employer_taxes', 'benefits', 'total_cost', 'employee_count'],
  },
  payroll_lines: {
    key: ['vendor', 'run_id', 'employee'],
    cols: ['vendor', 'run_id', 'employee', 'store', 'gross_wages', 'regular_hours', 'ot_hours', 'tips', 'employer_taxes'],
  },
  bank_transactions: {
    key: ['vendor', 'txn_id'],
    cols: ['vendor', 'account', 'txn_id', 'posted_date', 'amount', 'description', 'category'],
  },
};

let db;
const q = c => `"${c}"`;
export function open(file = path.join(opsDir(), 'ops.sqlite')) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  for (const [kind, def] of Object.entries(KINDS)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${kind} (${def.cols.map(q).join(',')}, extra TEXT, source_mode TEXT, collected_at TEXT, PRIMARY KEY (${def.key.map(q).join(',')}))`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor TEXT, mode TEXT, started_at TEXT, finished_at TEXT, ok INTEGER, records INTEGER, error TEXT)`);
  return db;
}
export function close() { db?.close(); db = undefined; }

// Upsert records of one kind. Unknown fields go into `extra`. Returns count written.
export function upsert(kind, records, { mode = null, at = new Date().toISOString() } = {}) {
  const def = KINDS[kind];
  if (!def) throw Error(`Unknown record kind: ${kind}`);
  if (!Array.isArray(records) || !records.length) return 0;
  const d = open();
  const cols = [...def.cols, 'extra', 'source_mode', 'collected_at'];
  const stmt = d.prepare(`INSERT OR REPLACE INTO ${kind} (${cols.map(q).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  d.exec('BEGIN');
  try {
    for (const r of records) {
      for (const k of def.key) if (r[k] === undefined || r[k] === null || r[k] === '') throw Error(`${kind} record missing key ${k}`);
      const extra = { ...(r.extra || {}) };
      for (const [k, v] of Object.entries(r)) if (!def.cols.includes(k) && k !== 'extra') extra[k] = v;
      stmt.run(...def.cols.map(c => r[c] ?? null), Object.keys(extra).length ? JSON.stringify(extra) : null, mode, at);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return records.length;
}

// Write a full adapter result ({kind: records[]}); returns total count.
export function upsertResult(result, opts) {
  let n = 0;
  for (const [kind, recs] of Object.entries(result || {})) n += upsert(kind, recs, opts);
  return n;
}

// Simple filtered read. filters: {vendor, store, from, through} using the kind's date column.
export const DATE_COL = {
  delivery_orders: 'business_date', delivery_payouts: 'payout_date', labor_shifts: 'business_date',
  schedule_shifts: 'business_date', payroll_runs: 'pay_date', payroll_lines: null, bank_transactions: 'posted_date',
};
export function query(kind, { vendor, store, from, through, limit = 5000 } = {}) {
  if (!KINDS[kind]) throw Error(`Unknown record kind: ${kind}`);
  const where = [], args = [], dc = DATE_COL[kind];
  if (vendor) { where.push('vendor = ?'); args.push(vendor); }
  if (store) { where.push('store = ?'); args.push(store); }
  if (dc && from) { where.push(`${q(dc)} >= ?`); args.push(from); }
  if (dc && through) { where.push(`${q(dc)} <= ?`); args.push(through); }
  const sql = `SELECT * FROM ${kind}${where.length ? ' WHERE ' + where.join(' AND ') : ''}${dc ? ` ORDER BY ${q(dc)}` : ''} LIMIT ?`;
  return open().prepare(sql).all(...args, limit).map(r => ({ ...r, extra: r.extra ? JSON.parse(r.extra) : undefined }));
}

export function recordRun({ vendor, mode, started_at, ok, records = 0, error = null }) {
  open().prepare('INSERT INTO runs (vendor, mode, started_at, finished_at, ok, records, error) VALUES (?,?,?,?,?,?,?)')
    .run(vendor, mode, started_at, new Date().toISOString(), ok ? 1 : 0, records, error ? String(error).slice(0, 500) : null);
}
export function lastRuns() {
  return open().prepare(`SELECT r.* FROM runs r JOIN (SELECT vendor, MAX(id) id FROM runs GROUP BY vendor) m ON r.id = m.id ORDER BY r.vendor`).all();
}
export function lastSuccess(vendor) {
  return open().prepare('SELECT finished_at FROM runs WHERE vendor = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(vendor)?.finished_at ?? null;
}
