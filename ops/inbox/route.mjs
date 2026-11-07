// Shared routing for the inbox and Drive lanes: expand zips, pick the first adapter
// that claims a file, parse it, and (optionally) persist + record runs.
import path from 'node:path';
import { isZip, unzip } from './zip.mjs';
import { sha256 } from './ledger.mjs';

export async function loadAdapters(adapters) {
  if (adapters) return adapters;
  const reg = await import('../core/registry.mjs');
  return await reg.adapters();
}

const MIME = { csv: 'text/csv', tsv: 'text/tab-separated-values', html: 'text/html', htm: 'text/html', txt: 'text/plain', json: 'application/json', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel' };
const guessMime = name => MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';

// One downloaded file -> candidate files (a zip becomes its entries). Each: {filename, ledgerName, buffer, mimeType, archive?}
export function expand(filename, buffer, mimeType) {
  if (!isZip(buffer, filename, mimeType)) return [{ filename, ledgerName: filename, buffer, mimeType }];
  return unzip(buffer)
    .filter(e => !/(^|\/)(__MACOSX\/|\.DS_Store$)/.test(e.name))
    .map(e => {
      const base = path.posix.basename(e.name);
      return { filename: base, ledgerName: `${filename}/${e.name}`, buffer: e.data, mimeType: guessMime(base), archive: filename };
    });
}

// Returns the first adapter (mode-eligible) whose matchFile(meta) is true, else null.
export function pickAdapter(adapters, meta, modes) {
  for (const a of adapters || []) {
    if (!a || typeof a.matchFile !== 'function' || typeof a.parseFile !== 'function') continue;
    if (!(a.modes || []).some(m => modes.includes(m))) continue;
    let hit = false;
    try { hit = Boolean(a.matchFile(meta)); } catch { hit = false; }
    if (hit) return a;
  }
  return null;
}

export const countRecords = result => Object.values(result || {}).reduce((n, r) => n + (Array.isArray(r) ? r.length : 0), 0);

// Parse one candidate. Returns a sweep item: {vendor, mode, messageId, file, records, result?, ok, error?, sha256}.
export async function routeFile(cand, baseMeta, adapters, { mode, modes }) {
  const meta = { ...baseMeta, filename: cand.filename, mimeType: cand.mimeType, ...(cand.archive ? { archive: cand.archive } : {}) };
  const item = { vendor: null, mode, messageId: meta.messageId, file: cand.ledgerName, records: 0, ok: false, sha256: sha256(cand.buffer) };
  const adapter = pickAdapter(adapters, meta, modes);
  if (!adapter) return { ...item, error: 'no adapter matched' };
  item.vendor = adapter.id;
  try {
    const result = (await adapter.parseFile(cand.buffer, meta)) || {};
    return { ...item, result, records: countRecords(result), ok: true };
  } catch (e) {
    return { ...item, error: `parse failed: ${e?.message || String(e)}`.slice(0, 500) };
  }
}

// Upsert ok items and record one run per vendor. Mutates items' ok/error on store failure.
export async function persistItems(items, { mode, startedAt }) {
  const store = await import('../core/store.mjs');
  const byVendor = new Map();
  for (const it of items) {
    if (!it.vendor) continue;
    if (it.ok && it.result) {
      try { it.records = store.upsertResult(it.result, { mode }); }
      catch (e) { it.ok = false; it.error = `store failed: ${e?.message || String(e)}`.slice(0, 500); }
    }
    const v = byVendor.get(it.vendor) || { ok: true, records: 0, errors: [] };
    v.ok &&= it.ok; v.records += it.ok ? it.records : 0;
    if (!it.ok && it.error) v.errors.push(`${it.file}: ${it.error}`);
    byVendor.set(it.vendor, v);
  }
  for (const [vendor, v] of byVendor) {
    store.recordRun({ vendor, mode, started_at: startedAt, ok: v.ok, records: v.records, error: v.errors.join('; ') || null });
  }
}
