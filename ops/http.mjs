// HTTP routes for the ops layer. src/main.js calls handleOps only for requests
// that already passed the XTRACHEF_MCP_SECRET path check, with `route` = the path
// after the secret (e.g. "/ops/status").
//
//   GET  /ops/handoff/vendors      vendors that take a pushed session + their cookie hosts (extra bearer token)
//   POST /ops/handoff/<vendorId>   Chrome pushes a logged-in storageState (extra bearer token). Stored only if it
//                                  passes the adapter's sign-in check (409 otherwise). 503 unless OPS_ENABLED=true.
//   GET  /ops/status               same payload as the ops_status MCP tool
//   POST /ops/sync[?vendor=id]     run collectors now (503 unless OPS_ENABLED=true)
import crypto from 'node:crypto';
import { opsModule, opsStatus, syncNow } from './tools.mjs';

export const MAX_HANDOFF_BYTES = 2 * 1024 * 1024;
const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
// Multi-label public suffixes we might plausibly see; everything else is treated as a single-label TLD.
const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'com.au', 'co.nz', 'com.mx', 'com.br', 'co.jp']);

export function registrableDomain(hostOrUrl) {
  let host = String(hostOrUrl || '').trim().toLowerCase();
  if (/^[a-z]+:\/\//.test(host)) { try { host = new URL(host).hostname; } catch { return null; } }
  host = host.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length < 2) return null;
  const n = TWO_LABEL_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.length >= n ? parts.slice(-n).join('.') : null;
}

const hostOf = hostOrUrl => {
  let host = String(hostOrUrl || '').trim().toLowerCase();
  if (/^[a-z]+:\/\//.test(host)) { try { host = new URL(host).hostname; } catch { return null; } }
  host = host.replace(/^\.+/, '').replace(/\.+$/, '');
  return host && registrableDomain(host) ? host : null;
};

// Hosts a vendor's session may legitimately carry cookies for. With handoffDomains: the loginUrl
// host plus each listed entry, kept exact ('auth.uber.com' stays 'auth.uber.com', it is not widened
// to 'uber.com'; listing a bare 'uber.com' still allows all of it). Without handoffDomains: the
// loginUrl's registrable domain, as before.
export function allowedDomains(adapter) {
  const out = new Set();
  const listed = (Array.isArray(adapter?.handoffDomains) ? adapter.handoffDomains : []).map(hostOf).filter(Boolean);
  const base = listed.length ? hostOf(adapter?.loginUrl) : registrableDomain(adapter?.loginUrl);
  if (base) out.add(base);
  for (const h of listed) out.add(h);
  return [...out];
}

// Allowed: a listed host or any subdomain of one (host-only cookies included). Also a domain
// cookie (leading dot) set on a parent of a listed host, because the browser sends it to that
// host ('.uber.com' reaches auth.uber.com) - but never on a bare public suffix, and never a
// host-only cookie of a parent (the browser would not send that one to the listed host).
export function domainAllowed(domain, allowed) {
  const raw = String(domain || '').toLowerCase();
  const d = raw.replace(/^\.+/, '');
  if (!d) return false;
  if (allowed.some(a => d === a || d.endsWith('.' + a))) return true;
  if (!raw.startsWith('.') || !registrableDomain(d)) return false;
  return allowed.some(a => a.endsWith('.' + d));
}

// Validate a Playwright storageState and keep only cookies/origins for the vendor's domains.
// Throws with a client-safe message on structural problems.
export function validateStorageState(state, allowed) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('storageState must be an object');
  if (!Array.isArray(state.cookies)) throw Error('storageState.cookies must be an array');
  const origins = state.origins ?? [];
  if (!Array.isArray(origins)) throw Error('storageState.origins must be an array');
  if (state.cookies.length > 2000) throw Error('too many cookies');
  const cookies = [];
  let dropped = 0;
  for (const c of state.cookies) {
    if (!c || typeof c !== 'object') throw Error('invalid cookie entry');
    if (typeof c.name !== 'string' || !c.name || typeof c.value !== 'string' || typeof c.domain !== 'string' || !c.domain) throw Error('cookie needs string name, value, domain');
    if (c.path !== undefined && typeof c.path !== 'string') throw Error('cookie path must be a string');
    if (c.expires !== undefined && (typeof c.expires !== 'number' || !Number.isFinite(c.expires))) throw Error('cookie expires must be a number (-1 for session)');
    if (c.sameSite !== undefined && !SAME_SITE.has(c.sameSite)) throw Error('cookie sameSite must be Strict, Lax or None');
    if (!domainAllowed(c.domain, allowed)) { dropped++; continue; }
    cookies.push({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      expires: c.expires ?? -1, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax',
    });
  }
  const keptOrigins = [];
  for (const o of origins) {
    if (!o || typeof o.origin !== 'string') throw Error('origin entry needs an origin string');
    let host;
    try { const u = new URL(o.origin); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw 0; host = u.hostname; } catch { throw Error('origin must be an http(s) URL'); }
    const ls = o.localStorage ?? [];
    if (!Array.isArray(ls) || ls.some(e => !e || typeof e.name !== 'string' || typeof e.value !== 'string')) throw Error('origin localStorage must be [{name, value}]');
    if (!domainAllowed(host, allowed)) { dropped++; continue; }
    keptOrigins.push({ origin: new URL(o.origin).origin, localStorage: ls.map(e => ({ name: e.name, value: e.value })) });
  }
  if (!cookies.length) throw Error(`no cookies for this vendor's domains (${allowed.join(', ')})`);
  return { storageState: { cookies, origins: keptOrigins }, dropped };
}

// Constant-time bearer check. Returns 'unconfigured' | 'denied' | 'ok'.
export function checkHandoffToken(header, token = process.env.OPS_HANDOFF_TOKEN) {
  if (typeof token !== 'string' || token.length < 32) return 'unconfigured';
  if (typeof header !== 'string') return 'denied';
  const a = crypto.createHash('sha256').update(header).digest();
  const b = crypto.createHash('sha256').update('Bearer ' + token).digest();
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'denied';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { const e = Error('payload too large'); e.status = 413; return reject(e); }
    const chunks = []; let size = 0, done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; const e = Error('payload too large'); e.status = 413; reject(e); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

const send = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify(obj));
};

export const DISABLED = 'ops layer disabled (set OPS_ENABLED=true)';
export const opsEnabled = (deps = {}) => (deps.enabled ?? process.env.OPS_ENABLED === 'true') === true;

async function resolveDeps(deps) {
  return {
    vault: deps.vault ?? (await opsModule('./core/vault.mjs')).mod,
    registry: deps.registry ?? (await opsModule('./core/registry.mjs')).mod,
    runner: deps.runner ?? (await opsModule('./core/runner.mjs')).mod,
    session: deps.session ?? (await opsModule('./core/session.mjs')).mod,
    log: deps.log ?? ((...a) => console.error('[ops]', ...a)),
  };
}

// Stores a pushed session only if it is actually signed in, so a signed-out Chrome can never
// overwrite a working server-side session. Runs inside runner.withBrowserLock so the check never
// races a collector run (or another handoff) over the same vault entry.
//   alive      -> keep it (source 'handoff')                    -> {status:'alive'}
//   not alive  -> put the previous session back, or clear it   -> {status:'dead'}
//   check threw (no browser, navigation error) -> keep it as 'handoff-unverified' -> {status:'unverified'}
export async function storeVerifiedSession(vendorId, adapter, incoming, { vault, runner, session, log = () => {} }) {
  const withLock = typeof runner?.withBrowserLock === 'function' ? fn => runner.withBrowserLock(fn) : fn => fn();
  return withLock(async () => {
    let prior = null;
    try { prior = typeof vault.loadSession === 'function' ? vault.loadSession(vendorId) : null; }
    catch (e) { log(`handoff ${vendorId}: previous session unreadable (${e?.message || e}); treating as none`); }
    const restore = () => {
      if (prior?.storageState) vault.saveSession(vendorId, prior.storageState, { source: prior.source || 'unknown' });
      else if (typeof vault.clearSession === 'function') vault.clearSession(vendorId);
    };
    // sessionAlive reads the session from the vault, so the candidate has to be there first.
    vault.saveSession(vendorId, incoming, { source: 'handoff-pending' });
    if (typeof adapter.isLoggedIn !== 'function' || typeof session?.sessionAlive !== 'function') {
      vault.saveSession(vendorId, incoming, { source: 'handoff-unverified' });
      return { status: 'unverified', reason: typeof adapter.isLoggedIn !== 'function' ? 'adapter has no isLoggedIn check' : 'session runtime not deployed' };
    }
    let alive;
    try { alive = await session.sessionAlive(adapter); }
    catch (e) {
      vault.saveSession(vendorId, incoming, { source: 'handoff-unverified' });
      return { status: 'unverified', reason: String(e?.message || e).slice(0, 200) };
    }
    try {
      if (!alive) { restore(); return { status: 'dead' }; }
      // On success sessionAlive saves the refreshed storageState (source 'refresh'); keep that copy so
      // cookies the vendor rotated during the check aren't reverted to the pushed ones.
      let current = null;
      try { current = typeof vault.loadSession === 'function' ? vault.loadSession(vendorId) : null; } catch { current = null; }
      vault.saveSession(vendorId, current?.source === 'refresh' && current.storageState ? current.storageState : incoming, { source: 'handoff' });
      return { status: 'alive' };
    } catch (e) { restore(); throw e; }
  });
}

async function handoff(req, res, vendorId, deps) {
  const verdict = checkHandoffToken(req.headers.authorization, deps.token ?? process.env.OPS_HANDOFF_TOKEN);
  if (verdict === 'unconfigured') return send(res, 503, { ok: false, error: 'handoff disabled: OPS_HANDOFF_TOKEN (>=32 chars) not set' });
  if (verdict !== 'ok') return send(res, 401, { ok: false, error: 'unauthorized' });
  if (!opsEnabled(deps)) return send(res, 503, { ok: false, error: DISABLED });
  const { vault, registry, runner, session, log } = await resolveDeps(deps);
  if (!registry?.getAdapter) return send(res, 503, { ok: false, error: 'vendor registry not deployed yet' });
  if (!vault?.saveSession) return send(res, 503, { ok: false, error: 'vault not deployed yet' });
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(vendorId)) return send(res, 404, { ok: false, error: 'unknown vendor' });
  let adapter;
  try { adapter = await registry.getAdapter(vendorId); } catch { adapter = null; }
  if (!adapter) return send(res, 404, { ok: false, error: `unknown vendor '${vendorId}'` });
  const allowed = allowedDomains(adapter);
  if (!allowed.length) return send(res, 500, { ok: false, error: 'vendor has no loginUrl to derive allowed cookie domains from' });

  let body;
  try { body = JSON.parse(await readBody(req, MAX_HANDOFF_BYTES)); }
  catch (e) { return send(res, e.status || 400, { ok: false, error: e.status === 413 ? 'payload too large (2MB max)' : 'body must be JSON' }); }
  let result;
  try { result = validateStorageState(body?.storageState, allowed); }
  catch (e) { return send(res, 400, { ok: false, error: e.message }); }

  const n = result.storageState.cookies.length;
  const v = await storeVerifiedSession(vendorId, adapter, result.storageState, { vault, runner, session, log });
  if (v.status === 'dead') {
    log(`handoff: rejected ${vendorId} session (not signed in); previous session kept`);
    return send(res, 409, { ok: false, vendor: vendorId, error: 'session not signed in' });
  }
  if (v.status === 'unverified') {
    log(`handoff: stored ${vendorId} session unverified (${v.reason}); ${n} cookies, ${result.dropped} off-domain entries dropped`);
    return send(res, 202, { ok: true, vendor: vendorId, verified: false, cookies: n, dropped: result.dropped, note: 'stored unverified: the sign-in check could not run' });
  }
  log(`handoff: stored verified session for ${vendorId} (${n} cookies, ${result.dropped} off-domain entries dropped)`);
  const canRun = typeof runner?.runVendorLocked === 'function';
  if (canRun) {
    Promise.resolve()
      .then(() => runner.runVendorLocked(vendorId, {}))
      .then(r => log(`handoff-triggered run ${vendorId}: ${r?.ok ? 'ok' : 'failed'}${r?.records != null ? ` records=${r.records}` : ''}${r?.error ? ` error=${String(r.error).slice(0, 200)}` : ''}`))
      .catch(e => log(`handoff-triggered run ${vendorId} threw: ${e?.message || e}`));
  }
  return send(res, 200, { ok: true, vendor: vendorId, verified: true, cookies: n, dropped: result.dropped, sync: canRun ? 'started' : 'runner not deployed yet' });
}

const SESSION_MODES = ['session', 'handoff', 'login'];
async function handoffVendors(req, res, deps) {
  const verdict = checkHandoffToken(req.headers.authorization, deps.token ?? process.env.OPS_HANDOFF_TOKEN);
  if (verdict === 'unconfigured') return send(res, 503, { ok: false, error: 'handoff disabled: OPS_HANDOFF_TOKEN (>=32 chars) not set' });
  if (verdict !== 'ok') return send(res, 401, { ok: false, error: 'unauthorized' });
  const { registry } = await resolveDeps(deps);
  if (!registry?.adapters) return send(res, 503, { ok: false, error: 'vendor registry not deployed yet' });
  const list = Array.from(await registry.adapters() || []);
  const vendors = list
    .filter(a => (a.modes || []).some(m => SESSION_MODES.includes(m)))
    .map(a => ({ id: a.id, name: a.name || a.id, loginUrl: a.loginUrl || null, domains: allowedDomains(a) }))
    .filter(v => v.domains.length);
  return send(res, 200, { ok: true, vendors });
}

// Returns true if the request was handled (any /ops/* route), false otherwise.
export async function handleOps(req, res, route, deps = {}) {
  if (typeof route !== 'string' || !(route === '/ops' || route.startsWith('/ops/'))) return false;
  const url = new URL(req.url, 'http://localhost');
  try {
    if (route === '/ops/handoff/vendors' && req.method === 'GET') { await handoffVendors(req, res, deps); return true; }
    const m = route.match(/^\/ops\/handoff\/([^/]+)\/?$/);
    if (m) {
      if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return true; }
      await handoff(req, res, decodeURIComponent(m[1]).toLowerCase(), deps);
      return true;
    }
    if (route === '/ops/status' && req.method === 'GET') { send(res, 200, await (deps.status ?? opsStatus)()); return true; }
    if (route === '/ops/sync' && req.method === 'POST') {
      const vendor = url.searchParams.get('vendor') || undefined;
      const from = url.searchParams.get('from') || undefined, through = url.searchParams.get('through') || undefined;
      if (!opsEnabled(deps)) { send(res, 503, { ok: false, error: DISABLED }); return true; }
      for (const d of [from, through]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) { send(res, 400, { ok: false, error: 'from/through must be YYYY-MM-DD' }); return true; }
      send(res, 200, await syncNow({ vendor, from, through }, deps));
      return true;
    }
    send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    (deps.log ?? console.error)('[ops] http error:', e?.message || e);
    if (!res.headersSent) send(res, 500, { ok: false, error: 'internal error' });
  }
  return true;
}
