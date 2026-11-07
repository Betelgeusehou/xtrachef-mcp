// Ops health: per-vendor freshness, session age, last-run outcome, missing creds. No secrets.
import { lastRuns, lastSuccess } from './store.mjs';
import { adapters as loadAdapters } from './registry.mjs';
import { listVault } from './vault.mjs';

const H = 3600000;
export const LIMITS = { noSuccessHours: 36, sessionMaxDays: 20 };

// opts.adaptersImpl / opts.vaultImpl let tests inject fixtures.
export async function opsHealth(now = new Date(), { adaptersImpl = loadAdapters, vaultImpl = listVault } = {}) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const enabled = process.env.OPS_ENABLED === 'true';
  const problems = [];
  let list = [];
  try { list = await adaptersImpl(); } catch (e) { problems.push(`adapters failed to load: ${e?.message || e}`); }
  for (const err of list.errors || []) problems.push(`vendor file ${err.file} invalid: ${err.problems.join('; ')}`);

  let vault = [];
  try { vault = vaultImpl(); } catch (e) { problems.push(`vault unreadable: ${e?.message || e}`); }
  const vaultBy = Object.fromEntries(vault.map(v => [v.vendor, v]));

  let runs = [];
  try { runs = lastRuns(); } catch (e) { problems.push(`store unreadable: ${e?.message || e}`); }
  const runBy = Object.fromEntries(runs.map(r => [r.vendor, r]));

  const vendors = list.map(a => {
    const v = vaultBy[a.id] || {};
    const run = runBy[a.id] || null;
    let success = null;
    try { success = lastSuccess(a.id); } catch { success = null; }
    const p = [];
    if (!success) p.push('never succeeded');
    else if (t - Date.parse(success) > LIMITS.noSuccessHours * H) p.push(`no success in ${Math.round((t - Date.parse(success)) / H)}h`);
    if (run && !run.ok) p.push(`last run failed (${run.mode}): ${run.error || 'unknown error'}`);
    const usesSession = a.modes.some(m => ['session', 'login', 'handoff'].includes(m));
    if (usesSession && v.hasSession && v.sessionSavedAt && t - Date.parse(v.sessionSavedAt) > LIMITS.sessionMaxDays * 24 * H) {
      p.push(`session is ${Math.floor((t - Date.parse(v.sessionSavedAt)) / (24 * H))} days old`);
    }
    if (usesSession && !v.hasSession && !a.modes.includes('login')) p.push('no stored session — needs handoff');
    if (a.modes.includes('login') && !v.hasCreds) p.push('credentials missing for login mode');
    return {
      vendor: a.id, name: a.name || a.id, domain: a.domain, modes: a.modes,
      lastRun: run ? { mode: run.mode, ok: !!run.ok, at: run.finished_at, records: run.records, error: run.error } : null,
      lastSuccess: success,
      hasCreds: !!v.hasCreds, hasSession: !!v.hasSession, sessionSavedAt: v.sessionSavedAt ?? null,
      problems: p,
    };
  });
  for (const v of vendors) for (const p of v.problems) problems.push(`${v.vendor}: ${p}`);
  return { state: problems.length ? 'ALERT' : 'ok', enabled, vendors, problems };
}
