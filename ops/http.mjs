// HTTP routes for the ops layer. src/main.js calls handleOps only for requests
// that already passed the XTRACHEF_MCP_SECRET path check, with `route` = the path
// after the secret (e.g. "/ops/status").
//
//   GET  /ops/handoff/vendors      vendors that take a pushed session + their cookie domains (extra bearer token)
//   POST /ops/handoff/<vendorId>   Chrome pushes a logged-in storageState (extra bearer token)
//   GET  /ops/status               same payload as the ops_status MCP tool
//   POST /ops/sync[?vendor=id]     run collectors now
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

// Registrable domains a vendor's session may legitimately carry cookies for.
export function allowedDomains(adapter) {
  const out = new Set();
  const base = registrableDomain(adapter?.loginUrl);
  if (base) out.add(base);
  for (const d of Array.isArray(adapter?.handoffDomains) ? adapter.handoffDomains : []) {
    const r = registrableDomain(d);
    if (r) out.add(r);
  }
  return [...out];
}

export function domainAllowed(domain, allowed) {
  const d = String(domain || '').toLowerCase().replace(/^\.+/, '');
  if (!d) return false;
  return allowed.some(a => d === a || d.endsWith('.' + a));
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

async function resolveDeps(deps) {
  return {
    vault: deps.vault ?? (await opsModule('./core/vault.mjs')).mod,
    registry: deps.registry ?? (await opsModule('./core/registry.mjs')).mod,
    runner: deps.runner ?? (await opsModule('./core/runner.mjs')).mod,
    log: deps.log ?? ((...a) => console.error('[ops]', ...a)),
  };
}

async function handoff(req, res, vendorId, deps) {
  const verdict = checkHandoffToken(req.headers.authorization, deps.token ?? process.env.OPS_HANDOFF_TOKEN);
  if (verdict === 'unconfigured') return send(res, 503, { ok: false, error: 'handoff disabled: OPS_HANDOFF_TOKEN (>=32 chars) not set' });
  if (verdict !== 'ok') return send(res, 401, { ok: false, error: 'unauthorized' });
  const { vault, registry, runner, log } = await resolveDeps(deps);
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

  await vault.saveSession(vendorId, result.storageState, { source: 'handoff' });
  log(`handoff: stored session for ${vendorId} (${result.storageState.cookies.length} cookies, ${result.dropped} off-domain entries dropped)`);
  if (runner?.runVendor) {
    Promise.resolve()
      .then(() => runner.runVendor(vendorId, {}))
      .then(r => log(`handoff-triggered run ${vendorId}: ${r?.ok ? 'ok' : 'failed'}${r?.records != null ? ` records=${r.records}` : ''}${r?.error ? ` error=${String(r.error).slice(0, 200)}` : ''}`))
      .catch(e => log(`handoff-triggered run ${vendorId} threw: ${e?.message || e}`));
  }
  return send(res, 200, { ok: true, vendor: vendorId, cookies: result.storageState.cookies.length, dropped: result.dropped, sync: runner?.runVendor ? 'started' : 'runner not deployed yet' });
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
