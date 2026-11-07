// Ops runner: runs vendor adapters through their acquisition modes, stores results, alerts on failure,
// and schedules itself at OPS_SYNC_HOURS (America/Chicago). Never runs two browsers at once.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { opsDir, upsertResult, recordRun } from './store.mjs';
import { adapters as loadAdapters, getAdapter } from './registry.mjs';
import { withSession as realWithSession, buildCtx, redact } from './session.mjs';
import { getCreds } from './vault.mjs';

export const TZ = 'America/Chicago';
const BROWSER_MODES = ['session', 'login', 'handoff'];
const INBOX_MODES = ['inbox', 'drive'];
export const EXPIRED = 'session expired — needs handoff';
export const UNMATCHED = 'inbox:unmatched';

// ---- error hygiene -----------------------------------------------------------------------------
// Every error that is stored (runs table), returned, or alerted goes through cleanError: the
// vendor's own credential values are scrubbed, generic secret patterns are redacted, and URLs
// keep only origin + path (query strings often carry tokens).
export function stripUrlQueries(s) {
  return String(s).replace(/\bhttps?:\/\/[^\s'"<>`]+/gi, m => {
    const [, u, tail] = m.match(/^(.*?)([).,;:!\]}]*)$/); // keep sentence punctuation outside the URL
    try { const x = new URL(u); return `${x.origin}${x.pathname}${tail}`; }
    catch { return u.split(/[?#]/)[0] + tail; }
  });
}
function secretsFor(id) {
  try { return Object.values(getCreds(id) || {}).filter(v => typeof v === 'string'); }
  catch { return []; }
}
export function cleanError(id, e, max = 300) {
  const msg = typeof e === 'string' ? e : String(e?.message || e || 'failed');
  return redact(stripUrlQueries(msg), secretsFor(id)).slice(0, max);
}

// ---- dates -------------------------------------------------------------------------------------
export function chicagoParts(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// Last 3 business days through yesterday (Chicago).
export function defaultRange(now = new Date()) {
  const through = addDays(chicagoParts(now).date, -1);
  return { from: addDays(through, -2), through };
}

// ---- one vendor --------------------------------------------------------------------------------
function plainCtx(adapter, logs) {
  // ctx for 'api' mode: everything but a browser page.
  const ctx = buildCtx(adapter, null, { logs, mode: 'api' });
  ctx.api = async (url, init = {}) => {
    const r = await fetch(url, init);
    const text = await r.text();
    if (!r.ok) throw Object.assign(Error(`${init.method || 'GET'} ${String(url).split('?')[0]} -> HTTP ${r.status}`), { status: r.status });
    return text ? JSON.parse(text) : null;
  };
  ctx.capture = async () => { throw Error('capture() needs a browser mode'); };
  return ctx;
}

const countOf = result => Object.values(result || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);

async function browserAttempt(adapter, range, { headless, mode, withSessionImpl, logs }) {
  return withSessionImpl(adapter, async ctx => {
    let loggedIn = !!(await adapter.isLoggedIn(ctx));
    if (!loggedIn && typeof adapter.login === 'function') {
      let creds = null;
      try { creds = getCreds(adapter.id); } catch (e) { ctx.log(`creds unavailable: ${e.message}`); }
      if (creds) {
        ctx.log('session not logged in; trying credential login');
        await adapter.login(ctx);
        loggedIn = !!(await adapter.isLoggedIn(ctx));
      }
    }
    if (!loggedIn) throw Object.assign(Error(EXPIRED), { expired: true });
    const result = await adapter.collect(ctx, range);
    return { result, records: upsertResult(result, { mode }) };
  }, { headless, mode, logs });
}

// Returns {vendor, ok, mode, records, error, attempts:[{mode, ok, records?, error?, skipped?}], logs}.
export async function runVendor(id, { range = defaultRange(), modes, headless = true, withSessionImpl = realWithSession, adapter } = {}) {
  adapter = adapter || await getAdapter(id);
  if (!adapter) return { vendor: id, ok: false, mode: null, records: 0, error: `unknown vendor ${id}`, attempts: [], logs: [] };
  const order = (modes && modes.length ? modes : adapter.modes).filter((m, i, a) => a.indexOf(m) === i);
  const attempts = [], logs = [];
  let browserTried = null;
  for (const mode of order) {
    if (INBOX_MODES.includes(mode)) { attempts.push({ mode, skipped: true, reason: 'handled by inbox sweep' }); continue; }
    if (BROWSER_MODES.includes(mode) && browserTried) { attempts.push({ mode, skipped: true, reason: `covered by ${browserTried}` }); continue; }
    if (mode !== 'api' && !BROWSER_MODES.includes(mode)) { attempts.push({ mode, skipped: true, reason: 'unknown mode' }); continue; }
    const started_at = new Date().toISOString();
    try {
      let records;
      if (mode === 'api') {
        records = upsertResult(await adapter.collect(plainCtx(adapter, logs), range), { mode });
      } else {
        browserTried = mode;
        ({ records } = await browserAttempt(adapter, range, { headless, mode, withSessionImpl, logs }));
      }
      recordRun({ vendor: adapter.id, mode, started_at, ok: true, records });
      attempts.push({ mode, ok: true, records });
      return { vendor: adapter.id, ok: true, mode, records, error: null, attempts, logs };
    } catch (e) {
      const error = e?.expired ? EXPIRED : cleanError(adapter.id, e);
      recordRun({ vendor: adapter.id, mode, started_at, ok: false, records: 0, error });
      attempts.push({ mode, ok: false, error });
    }
  }
  const failed = attempts.filter(a => !a.skipped);
  if (!failed.length) return { vendor: adapter.id, ok: true, mode: null, records: 0, error: null, skipped: true, attempts, logs };
  const last = failed[failed.length - 1];
  return { vendor: adapter.id, ok: false, mode: last.mode, records: 0, error: last.error, attempts, logs };
}

// ---- inbox sweep ---------------------------------------------------------------------------------
// Contract with ops/inbox/index.mjs: `sweepInbox()` returns an array (or {items: [...]}) of
// {vendor, mode?: 'inbox'|'drive', result?: {kind: Record[]}, ok?, error?, file?}.
// Items with a `result` are upserted here; every item is recorded as a run for that vendor.
async function runInboxSweep(importImpl) {
  let mod;
  try { mod = await importImpl(); }
  catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') return { skipped: true, reason: 'ops/inbox not installed' };
    return { ok: false, error: cleanError('inbox', e) };
  }
  if (typeof mod?.sweepInbox !== 'function') return { skipped: true, reason: 'sweepInbox not exported' };
  const started_at = new Date().toISOString();
  let out;
  try { out = await mod.sweepInbox(); }
  catch (e) {
    const error = cleanError('inbox', e);
    recordRun({ vendor: 'inbox', mode: 'inbox', started_at, ok: false, error });
    return { ok: false, error };
  }
  const items = Array.isArray(out) ? out : Array.isArray(out?.items) ? out.items : [];
  const results = [];
  for (const it of items) {
    if (!it) continue;
    const mode = it.mode || 'inbox';
    if (!it.vendor) {
      // No adapter claimed this file (or it failed to download). Never drop it silently.
      const vendor = it.file ? UNMATCHED : 'inbox';
      const why = cleanError(vendor, it.error || 'no adapter matched', 250);
      const error = it.file ? `unmatched report file ${stripUrlQueries(it.file)}: ${why}`.slice(0, 300) : why;
      try { recordRun({ vendor, mode, started_at, ok: false, records: 0, error }); }
      catch (e) { console.error('[ops] recordRun failed:', cleanError(vendor, e)); }
      results.push({ vendor, mode, ok: false, records: 0, error, ...(it.file ? { file: String(it.file) } : {}) });
      continue;
    }
    try {
      const records = it.result ? upsertResult(it.result, { mode }) : (it.records ?? 0);
      const ok = it.ok !== false && !it.error;
      const error = ok ? null : cleanError(it.vendor, it.error || 'failed');
      recordRun({ vendor: it.vendor, mode, started_at, ok, records, error });
      results.push({ vendor: it.vendor, mode, ok, records, error });
    } catch (e) {
      const error = cleanError(it.vendor, e);
      try { recordRun({ vendor: it.vendor, mode, started_at, ok: false, error }); }
      catch (e2) { console.error('[ops] recordRun failed:', cleanError(it.vendor, e2)); }
      results.push({ vendor: it.vendor, mode, ok: false, records: 0, error });
    }
  }
  return { ok: results.every(r => r.ok), results };
}

// ---- all vendors, serialized ------------------------------------------------------------------
let chain = Promise.resolve();
let busy = false;
export const isRunning = () => busy;
function locked(fn) {
  const p = chain.then(async () => { busy = true; try { return await fn(); } finally { busy = false; } });
  chain = p.catch(() => {});
  return p;
}
// Shared single-browser lock for callers outside the runner (HTTP handoff, MCP tools).
export const runVendorLocked = (id, opts) => locked(() => runVendor(id, opts));
export const withBrowserLock = fn => locked(fn);

export function runAll(opts = {}) {
  return locked(async () => {
    const { adaptersImpl = loadAdapters, inboxImport = () => import('../inbox/index.mjs'), alert = true } = opts;
    const list = await adaptersImpl();
    const results = [];
    for (const a of list) {
      if (!a.modes.some(m => m === 'api' || BROWSER_MODES.includes(m))) continue; // inbox-only vendors
      const r = await runVendor(a.id, { ...opts, adapter: a });
      delete r.logs;
      results.push(r);
    }
    const inbox = await runInboxSweep(inboxImport);
    if (alert) await alertFailures([...results, ...(inbox.results || []), ...(inbox.ok === false && !inbox.results ? [{ vendor: 'inbox', ok: false, error: inbox.error }] : [])], opts);
    return { at: new Date().toISOString(), ok: results.every(r => r.ok) && inbox.ok !== false, results, inbox };
  });
}

// ---- status + alerts ------------------------------------------------------------------------------
export const statusFile = () => path.join(opsDir(), 'run-status.json');
export function readStatus() {
  try { return JSON.parse(fs.readFileSync(statusFile(), 'utf8')); } catch { return {}; }
}
function writeStatus(s) {
  const f = statusFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, f);
}

export async function alertFailures(results, { fetchImpl = fetch, now = new Date() } = {}) {
  const url = process.env.OPS_ALERT_WEBHOOK || process.env.XTRACHEF_ALERT_WEBHOOK;
  const failed = results.filter(r => r && r.ok === false);
  if (!url || !failed.length) return [];
  const today = chicagoParts(now).date;
  const status = readStatus();
  const sent = status.alerts || {};
  // Vendors alert once per Chicago day; unmatched inbox files alert once per file, ever.
  const keyOf = r => r.vendor === UNMATCHED ? `${UNMATCHED}:${r.file || r.error}` : r.vendor;
  const seen = new Set();
  const fresh = failed.filter(r => {
    const k = keyOf(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return r.vendor === UNMATCHED ? !sent[k] : sent[k] !== today;
  });
  if (!fresh.length) return [];
  const body = fresh.map(r => `${r.vendor}${r.mode ? ` (${r.mode})` : ''}: ${cleanError(r.vendor, r.error || 'failed', 200)}`).join('\n');
  try {
    await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/plain', Title: 'Ops connector alert', Priority: 'high' }, body });
    for (const r of fresh) sent[keyOf(r)] = today;
    writeStatus({ ...readStatus(), alerts: sent });
  } catch (e) { console.error('[ops] alert webhook failed:', cleanError('alert', e)); }
  return fresh.map(keyOf);
}

// ---- scheduler ---------------------------------------------------------------------------------------
export const syncHours = () => (process.env.OPS_SYNC_HOURS || '4,5,6,14').split(',').map(s => parseInt(s, 10)).filter(n => n >= 0 && n < 24);

export async function tick(now = new Date(), opts = {}) {
  if (process.env.OPS_ENABLED !== 'true' || busy) return null;
  const { date, hour } = chicagoParts(now);
  if (!syncHours().includes(hour)) return null;
  const key = `${date}T${String(hour).padStart(2, '0')}`;
  const prior = readStatus();
  if (prior.lastKey === key && prior.state !== 'running') return null;
  try {
    writeStatus({ ...prior, lastKey: key, state: 'running', startedAt: now.toISOString() });
    const out = await runAll(opts);
    writeStatus({ ...readStatus(), lastKey: key, state: out.ok ? 'ok' : 'partial', completedAt: new Date().toISOString(),
      results: out.results.map(({ vendor, ok, mode, records, error }) => ({ vendor, ok, mode, records, error })), inbox: out.inbox });
    return out;
  } catch (e) {
    const error = cleanError('runner', e);
    console.error('[ops] tick failed:', error);
    try { writeStatus({ ...readStatus(), lastKey: key, state: 'error', completedAt: new Date().toISOString(), error }); }
    catch (e2) { console.error('[ops] status write failed:', cleanError('runner', e2)); }
    return null;
  }
}

// Scheduler entry: never rejects, so a timer can never raise an unhandled rejection.
export function safeTick(now, opts) {
  try { return tick(now, opts).catch(e => { console.error('[ops] tick', cleanError('runner', e)); return null; }); }
  catch (e) { console.error('[ops] tick', cleanError('runner', e)); return Promise.resolve(null); }
}

let timer;
export function startOpsRunner() {
  if (process.env.OPS_ENABLED !== 'true' || timer) return false;
  safeTick();
  timer = setInterval(() => { safeTick(); }, 60000);
  timer.unref();
  return true;
}
export function stopOpsRunner() { clearInterval(timer); timer = undefined; }
