// Loads and validates vendor adapters from ops/vendors/*.mjs (or OPS_VENDORS_DIR / {dir}).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KINDS } from './store.mjs';

export const MODES = ['api', 'session', 'login', 'handoff', 'inbox', 'drive'];
export const DOMAINS = ['delivery', 'labor', 'payroll', 'sales', 'invoices', 'banking'];
const defaultDir = () => process.env.OPS_VENDORS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendors');

// Returns a list of problems (empty = valid).
export function validateAdapter(a) {
  const p = [];
  if (!a || typeof a !== 'object') return ['default export is not an object'];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.id || '')) p.push('id must be kebab-case');
  if (!a.domain || !DOMAINS.includes(a.domain)) p.push(`domain must be one of ${DOMAINS.join('|')}`);
  if (!Array.isArray(a.modes) || !a.modes.length) p.push('modes must be a non-empty array');
  else for (const m of a.modes) if (!MODES.includes(m)) p.push(`unknown mode ${m}`);
  if (!Array.isArray(a.kinds)) p.push('kinds must be an array');
  else for (const k of a.kinds) if (!KINDS[k]) p.push(`unknown kind ${k}`);
  const modes = Array.isArray(a.modes) ? a.modes : [];
  if (modes.some(m => ['session', 'login', 'handoff'].includes(m))) {
    if (typeof a.isLoggedIn !== 'function') p.push('session modes need isLoggedIn(ctx)');
    if (typeof a.collect !== 'function') p.push('session modes need collect(ctx, range)');
    if (!a.loginUrl) p.push('session modes need loginUrl');
  }
  if (modes.includes('login') && typeof a.login !== 'function') p.push("'login' mode needs login(ctx)");
  if (modes.includes('api') && typeof a.collect !== 'function') p.push("'api' mode needs collect(ctx, range)");
  if (modes.some(m => m === 'inbox' || m === 'drive')) {
    if (typeof a.matchFile !== 'function') p.push('inbox/drive modes need matchFile(meta)');
    if (typeof a.parseFile !== 'function') p.push('inbox/drive modes need parseFile(buffer, meta)');
  }
  return p;
}

const cache = new Map();
// Loads every adapter. Invalid ones are skipped and reported in adapters.errors (never thrown) so one
// broken vendor file can't take down the runner.
export async function adapters({ dir = defaultDir(), reload = false } = {}) {
  if (!reload && cache.has(dir)) return cache.get(dir);
  const list = [];
  list.errors = [];
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !f.startsWith('_')).sort();
    const seen = new Set();
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const url = pathToFileURL(full).href + (reload ? `?t=${Date.now()}` : '');
        const a = (await import(url)).default;
        const probs = validateAdapter(a);
        if (!probs.length && seen.has(a.id)) probs.push(`duplicate id ${a.id}`);
        if (probs.length) { list.errors.push({ file: f, problems: probs }); continue; }
        seen.add(a.id);
        list.push(a);
      } catch (e) {
        list.errors.push({ file: f, problems: [`import failed: ${e?.message || e}`] });
      }
    }
  }
  for (const e of list.errors) console.error(`[ops] skipped vendor ${e.file}: ${e.problems.join('; ')}`);
  cache.set(dir, list);
  return list;
}

export async function getAdapter(id, opts) {
  return (await adapters(opts)).find(a => a.id === id) ?? null;
}
