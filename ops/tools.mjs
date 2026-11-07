// MCP tools for the ops connector layer. Every sibling module is imported lazily
// so the server boots (and these tools explain what's missing) even when a
// module hasn't been deployed yet. See ops/README.md for record shapes.

const STORES = ['Montrose', 'Washington'];
const SECRET_KEY = /^(pass|password|secret|token|access_?token|refresh_?token|api_?key|cookie|cookies|totp|totp_?secret|storage_?state|creds|credentials|session_?data)$/i;

const cache = new Map();
// Import an ops module relative to this file; returns null (and remembers why) if absent.
export async function opsModule(rel) {
  if (cache.has(rel)) return cache.get(rel);
  let entry;
  try { entry = { mod: await import(new URL(rel, import.meta.url).href) }; }
  catch (e) { entry = { mod: null, error: e?.code === 'ERR_MODULE_NOT_FOUND' ? 'not deployed yet' : (e?.message || String(e)) }; }
  // Only cache successes so a module deployed later is picked up without restart.
  if (entry.mod) cache.set(rel, entry);
  return entry;
}
const mod = async rel => (await opsModule(rel)).mod;

export const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
const has = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const pct = (a, b) => (b ? r2((a / b) * 100) : null);

// Strip anything that looks like a secret from an object tree (defense in depth;
// health/vault are contracted never to return secrets).
export function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET_KEY.test(k)) out[k] = scrub(x);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------- status
export async function opsStatus(deps = {}) {
  const health = deps.health ?? await mod('./core/health.mjs');
  const vault = deps.vault ?? await mod('./core/vault.mjs');
  const store = deps.store ?? await mod('./core/store.mjs');
  const missing = [];
  let h = null, v = [], runs = [];
  if (health?.opsHealth) { try { h = await health.opsHealth(); } catch (e) { missing.push(`health check failed: ${e.message}`); } }
  else missing.push('ops/core/health.mjs not deployed yet');
  if (vault?.listVault) { try { v = await vault.listVault(); } catch (e) { missing.push(`vault unreadable: ${e.message}`); } }
  else missing.push('ops/core/vault.mjs not deployed yet');
  if (store?.lastRuns) { try { runs = store.lastRuns(); } catch (e) { missing.push(`store unreadable: ${e.message}`); } }

  const byId = new Map();
  const slot = id => { if (!byId.has(id)) byId.set(id, { vendor: id }); return byId.get(id); };
  for (const hv of h?.vendors || []) { const id = hv.vendor || hv.id; if (id) Object.assign(slot(id), hv, { vendor: id }); }
  for (const vv of v || []) {
    if (!vv?.vendor) continue;
    slot(vv.vendor).vault = { hasCreds: !!vv.hasCreds, hasSession: !!vv.hasSession, sessionSavedAt: vv.sessionSavedAt ?? null, sessionSource: vv.sessionSource ?? null };
  }
  for (const r of runs) {
    if (!r?.vendor) continue;
    const s = slot(r.vendor);
    if (!s.lastRun) s.lastRun = { mode: r.mode, finished_at: r.finished_at, ok: !!r.ok, records: r.records, error: r.error };
  }
  return scrub({
    state: h?.state ?? (process.env.OPS_ENABLED === 'true' ? 'unknown' : 'disabled'),
    enabled: h?.enabled ?? process.env.OPS_ENABLED === 'true',
    vendors: [...byId.values()].sort((a, b) => a.vendor.localeCompare(b.vendor)),
    problems: [...(h?.problems || []), ...missing],
  });
}

// Explain why a kind has no rows: which vendors should produce it and what health says about them.
export async function emptyState(kinds, filters = {}, deps = {}) {
  const registry = deps.registry ?? await mod('./core/registry.mjs');
  let status;
  try { status = await opsStatus(deps); } catch { status = { vendors: [], problems: [], enabled: false }; }
  let adapters = [];
  if (registry?.adapters) { try { adapters = Array.from(await registry.adapters() || []); } catch { adapters = []; } }
  const producers = adapters.filter(a => (a.kinds || []).some(k => kinds.includes(k)) && (!filters.vendor || a.id === filters.vendor));
  const vendors = producers.map(a => {
    const s = status.vendors.find(x => x.vendor === a.id) || {};
    let why;
    if (!status.enabled) why = 'ops layer disabled (set OPS_ENABLED=true)';
    else if (Array.isArray(s.problems) && s.problems.length) why = s.problems.join('; ');
    else if (s.lastRun && !s.lastRun.ok) why = `last run failed: ${s.lastRun.error || 'unknown error'}`;
    else if (!s.lastRun) why = 'no collection run yet';
    else if (s.vault && !s.vault.hasSession && !s.vault.hasCreds && (a.modes || []).some(m => m === 'session' || m === 'handoff' || m === 'login')) why = 'no session or credentials stored — push a session from Chrome (ops/handoff) or set creds';
    else why = 'collected, but nothing in this date range/store';
    return { vendor: a.id, name: a.name, state: s.state ?? null, why };
  });
  const range = [filters.from && `from ${filters.from}`, filters.through && `through ${filters.through}`, filters.store && `store ${filters.store}`].filter(Boolean).join(', ');
  let message;
  if (!registry) message = `No ${kinds.join('/')} data${range ? ` (${range})` : ''}: vendor registry (ops/core/registry.mjs) not deployed yet.`;
  else if (!producers.length) message = `No ${kinds.join('/')} data${range ? ` (${range})` : ''}: no registered vendor produces ${kinds.join(' or ')}${filters.vendor ? ` for vendor '${filters.vendor}'` : ''}.`;
  else message = `No ${kinds.join('/')} data${range ? ` (${range})` : ''}. ` + vendors.map(v => `${v.name || v.vendor}: ${v.why}`).join('; ');
  return { empty: true, message, vendors, problems: status.problems };
}

// ---------------------------------------------------------------- delivery
const DERIVED_NOTE = 'payouts derived from order rows — reconcile against bank deposits';
// Pure math over delivery_orders + delivery_payouts rows.
export function computeDelivery(orders, payouts) {
  const groups = new Map();
  const key = (v, s) => `${v}\u0000${s || 'Unknown'}`;
  const g = (v, s) => {
    const k = key(v, s);
    if (!groups.has(k)) groups.set(k, { vendor: v, store: s || 'Unknown', orders: 0, cancelled: 0, subtotal: 0, tax: 0, tip: 0, commission: 0, processing_fee: 0, marketing_fee: 0, error_charges: 0, adjustments: 0, net_payout: 0, payouts_reported: 0, payout_count: 0, derived_payouts: 0, derived_payout_count: 0 });
    return groups.get(k);
  };
  for (const o of orders) {
    const x = g(o.vendor, o.store);
    // A cancelled order isn't a sale: its subtotal/tax/tip/fees stay out of gross, take rate and
    // avg ticket. Money that actually moved on it (partial payout, error charges, adjustments) still counts.
    const cancelled = /cancel/i.test(o.status || '');
    if (cancelled) x.cancelled++; else x.orders++;
    const fields = cancelled ? ['error_charges', 'adjustments'] : ['subtotal', 'tax', 'tip', 'commission', 'processing_fee', 'marketing_fee', 'error_charges', 'adjustments'];
    for (const f of fields) x[f] += num(o[f]);
    if (cancelled) x.cancelled_error_charges = (x.cancelled_error_charges || 0) + num(o.error_charges);
    x.net_payout += num(o.payout);
  }
  for (const p of payouts) {
    const x = g(p.vendor, p.store);
    // Payout rows a vendor adapter rebuilt from the order rows themselves can't reconcile against
    // those same orders; keep them out and point at bank deposits instead.
    if (p.extra?.derived_from_orders) { x.derived_payouts += num(p.net_payout); x.derived_payout_count++; continue; }
    x.payouts_reported += num(p.net_payout);
    x.payout_count++;
  }
  const finish = x => {
    // Fees are the vendor's cut (always charged as positive amounts); adjustments are reported separately because they can go either way.
    const fees = x.commission + x.processing_fee + x.marketing_fee + x.error_charges;
    // Take rate is over completed orders only: error charges on cancelled orders are a real cost
    // (in total_fees) but have no subtotal behind them, so they'd inflate the rate.
    const saleFees = fees - (x.cancelled_error_charges || 0);
    const out = {
      vendor: x.vendor, store: x.store, orders: x.orders, cancelled: x.cancelled,
      gross_subtotal: r2(x.subtotal), tax: r2(x.tax), tip: r2(x.tip),
      commission: r2(x.commission), processing_fee: r2(x.processing_fee), marketing: r2(x.marketing_fee),
      error_charges: r2(x.error_charges), adjustments: r2(x.adjustments),
      total_fees: r2(fees), net_payout: r2(x.net_payout),
      effective_take_rate_pct: pct(saleFees, x.subtotal),
      avg_ticket: x.orders ? r2(x.subtotal / x.orders) : null,
      reconciliation: x.payout_count || !x.derived_payout_count
        ? {
          order_payouts: r2(x.net_payout), payouts_reported: r2(x.payouts_reported), payout_count: x.payout_count,
          difference: r2(x.payouts_reported - x.net_payout),
          ...(x.derived_payout_count ? { derived_payouts_excluded: x.derived_payout_count } : {}),
        }
        : { order_payouts: r2(x.net_payout), payouts_reported: null, payout_count: 0, difference: null, derived_payouts_excluded: x.derived_payout_count, note: DERIVED_NOTE },
    };
    return out;
  };
  const rows = [...groups.values()].map(finish).sort((a, b) => a.vendor.localeCompare(b.vendor) || a.store.localeCompare(b.store));
  const t = [...groups.values()].reduce((a, x) => { for (const k of Object.keys(x)) if (typeof x[k] === 'number') a[k] = (a[k] || 0) + x[k]; return a; }, {});
  const totals = rows.length ? finish({ vendor: 'ALL', store: 'ALL', ...t }) : null;
  return { rows, totals };
}

export async function deliverySummary({ from, through, store, vendor } = {}, deps = {}) {
  const s = deps.store ?? await mod('./core/store.mjs');
  if (!s) return { empty: true, message: 'ops store not available' };
  const f = { from, through, store, vendor, limit: 200000 };
  const orders = s.query('delivery_orders', f);
  const payouts = s.query('delivery_payouts', f);
  if (!orders.length && !payouts.length) return { from, through, ...(await emptyState(['delivery_orders', 'delivery_payouts'], f, deps)) };
  const { rows, totals } = computeDelivery(orders, payouts);
  const derivedVendors = [...new Set(payouts.filter(p => p.extra?.derived_from_orders).map(p => p.vendor))].sort();
  return {
    from, through, store: store || 'all', vendor: vendor || 'all',
    notes: [
      'total_fees = commission + processing_fee + marketing + error_charges. gross_subtotal, avg_ticket and effective_take_rate_pct (fees on completed orders / gross_subtotal) exclude cancelled orders; their payout, error charges and adjustments still count.',
      'reconciliation compares the sum of per-order payouts (orders by business_date) with payouts deposited (by payout_date) in the same range; a nonzero difference at range edges is usually timing, not missing money.',
      ...(derivedVendors.length ? [`${derivedVendors.join(', ')}: ${DERIVED_NOTE}. Those payout rows are left out of payouts_reported.`] : []),
    ],
    by_vendor_store: rows, totals,
  };
}

// ---------------------------------------------------------------- labor
const hoursBetween = (a, b) => { const t = Date.parse(b) - Date.parse(a); return Number.isFinite(t) && t > 0 ? t / 3600000 : 0; };
export function computeLabor(shifts, schedule, { top = 5 } = {}) {
  const notes = [];
  // Avoid double-counting when two vendors (e.g. Toast and Homebase) both report time punches for a store.
  const vendorsByStore = new Map();
  for (const r of shifts) { const m = vendorsByStore.get(r.store) || new Map(); m.set(r.vendor, (m.get(r.vendor) || 0) + 1); vendorsByStore.set(r.store, m); }
  const chosen = new Map();
  for (const [st, m] of vendorsByStore) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    chosen.set(st, best);
    if (m.size > 1) notes.push(`${st}: time punches from ${[...m.keys()].join(' and ')}; using ${best} (most shifts). Pass vendor to pick one.`);
  }
  const days = new Map();
  const day = (st, d) => { const k = `${st}\u0000${d}`; if (!days.has(k)) days.set(k, { store: st || 'Unknown', business_date: d, actual_hours: 0, ot_hours: 0, actual_cost: 0, cost_estimated: false, scheduled_hours: 0, scheduled_cost: 0, shifts: 0, scheduled_shifts: 0 }); return days.get(k); };
  const ot = new Map();
  for (const r of shifts) {
    if (chosen.get(r.store) !== r.vendor) continue;
    const x = day(r.store, r.business_date);
    // Hours come from regular_hours when the vendor reports it, else from the punch times.
    // ot_hours alone (often 0) says nothing about total hours, so it never selects the branch.
    const o = num(r.ot_hours);
    const hrs = has(r.regular_hours) ? num(r.regular_hours) + o : hoursBetween(r.clock_in, r.clock_out);
    const reg = Math.max(0, hrs - o);
    x.actual_hours += hrs; x.ot_hours += o; x.shifts++;
    if (has(r.labor_cost)) x.actual_cost += num(r.labor_cost);
    else if (has(r.wage_rate)) { x.actual_cost += num(r.wage_rate) * (reg + 1.5 * o); x.cost_estimated = true; }
    if (o > 0) { const k = `${r.store}\u0000${r.employee}`; const e = ot.get(k) || { store: r.store, employee: r.employee, ot_hours: 0, shifts_with_ot: 0 }; e.ot_hours += o; e.shifts_with_ot++; ot.set(k, e); }
  }
  for (const r of schedule) {
    const x = day(r.store, r.business_date);
    x.scheduled_hours += has(r.scheduled_hours) ? num(r.scheduled_hours) : hoursBetween(r.start, r.end);
    x.scheduled_cost += num(r.scheduled_cost); x.scheduled_shifts++;
  }
  const fmt = x => ({
    store: x.store, business_date: x.business_date, shifts: x.shifts, scheduled_shifts: x.scheduled_shifts,
    actual_hours: r2(x.actual_hours), scheduled_hours: r2(x.scheduled_hours), hours_variance: r2(x.actual_hours - x.scheduled_hours),
    actual_cost: r2(x.actual_cost), scheduled_cost: r2(x.scheduled_cost), cost_variance: r2(x.actual_cost - x.scheduled_cost),
    ot_hours: r2(x.ot_hours), ...(x.cost_estimated ? { cost_estimated: true } : {}),
  });
  const daily = [...days.values()].sort((a, b) => a.store.localeCompare(b.store) || String(a.business_date).localeCompare(String(b.business_date))).map(fmt);
  const byStore = {};
  for (const d of daily) {
    const s = byStore[d.store] ||= { actual_hours: 0, scheduled_hours: 0, actual_cost: 0, scheduled_cost: 0, ot_hours: 0, days: 0 };
    for (const k of ['actual_hours', 'scheduled_hours', 'actual_cost', 'scheduled_cost', 'ot_hours']) s[k] += d[k];
    s.days++;
  }
  for (const [st, s] of Object.entries(byStore)) {
    byStore[st] = {
      days: s.days, actual_hours: r2(s.actual_hours), scheduled_hours: r2(s.scheduled_hours), hours_variance: r2(s.actual_hours - s.scheduled_hours),
      actual_cost: r2(s.actual_cost), scheduled_cost: r2(s.scheduled_cost), cost_variance: r2(s.actual_cost - s.scheduled_cost), ot_hours: r2(s.ot_hours),
      time_punch_source: chosen.get(st) ?? null,
      top_ot_employees: [...ot.values()].filter(e => e.store === st).sort((a, b) => b.ot_hours - a.ot_hours).slice(0, top).map(e => ({ employee: e.employee, ot_hours: r2(e.ot_hours), shifts_with_ot: e.shifts_with_ot })),
    };
  }
  if (daily.some(d => d.cost_estimated)) notes.push('cost_estimated days have shifts without labor_cost; cost = wage_rate x (regular + 1.5 x OT hours).');
  if (!schedule.length) notes.push('No schedule_shifts in range, so scheduled figures are 0 (Homebase schedule not collected yet?).');
  return { by_store: byStore, daily, notes };
}

export async function laborSummary({ from, through, store, vendor } = {}, deps = {}) {
  const s = deps.store ?? await mod('./core/store.mjs');
  if (!s) return { empty: true, message: 'ops store not available' };
  const f = { from, through, store, limit: 200000 };
  const shifts = s.query('labor_shifts', { ...f, vendor });
  const schedule = s.query('schedule_shifts', f);
  if (!shifts.length && !schedule.length) return { from, through, ...(await emptyState(['labor_shifts', 'schedule_shifts'], { ...f, vendor }, deps)) };
  return { from, through, store: store || 'all', ...computeLabor(shifts, schedule) };
}

// ---------------------------------------------------------------- payroll
// Tips pass through payroll but aren't wages the restaurant pays for, so burden % is taken over
// wages excluding tips: (employer_taxes + benefits) / wages_ex_tips. Source of wages_ex_tips, in order:
// run.extra.wages_ex_tips; gross_wages - (run.extra.tips or the run's payroll_lines tips); gross_wages.
export function computePayroll(runs, lines = []) {
  const notes = [];
  const lineAgg = new Map();
  for (const l of lines) {
    const k = `${l.vendor}\u0000${l.run_id}`;
    const a = lineAgg.get(k) || { employees: new Set(), ot_hours: 0, regular_hours: 0, tips: 0, hasTips: false };
    a.employees.add(l.employee); a.ot_hours += num(l.ot_hours); a.regular_hours += num(l.regular_hours); a.tips += num(l.tips);
    if (has(l.tips)) a.hasTips = true;
    lineAgg.set(k, a);
  }
  const fallback = [];
  const out = runs.map(r => {
    const gross = num(r.gross_wages), taxes = num(r.employer_taxes), ben = num(r.benefits);
    const total = has(r.total_cost) ? num(r.total_cost) : gross + taxes + ben;
    const la = lineAgg.get(`${r.vendor}\u0000${r.run_id}`);
    const ex = r.extra || {};
    let wagesEx, tips, wagesSource;
    if (has(ex.wages_ex_tips)) { wagesEx = num(ex.wages_ex_tips); tips = has(ex.tips) ? num(ex.tips) : gross - wagesEx; wagesSource = 'run'; }
    else if (has(ex.tips)) { tips = num(ex.tips); wagesEx = gross - tips; wagesSource = 'run tips'; }
    else if (la?.hasTips) { tips = la.tips; wagesEx = gross - tips; wagesSource = 'payroll_lines tips'; }
    else { tips = null; wagesEx = gross; wagesSource = 'gross_wages (tips unknown)'; fallback.push(r.run_id); }
    return {
      vendor: r.vendor, store: r.store || 'Unknown', run_id: r.run_id, pay_date: r.pay_date, period_start: r.period_start, period_end: r.period_end,
      employee_count: has(r.employee_count) ? num(r.employee_count) : (la ? la.employees.size : null),
      gross_wages: r2(gross), tips: tips === null ? null : r2(tips), wages_ex_tips: r2(wagesEx), wages_ex_tips_source: wagesSource,
      employer_taxes: r2(taxes), benefits: r2(ben), total_cost: r2(total),
      employer_burden_pct: wagesEx ? r2(((taxes + ben) / wagesEx) * 100) : null,
      ...(la ? { regular_hours: r2(la.regular_hours), ot_hours: r2(la.ot_hours) } : {}),
    };
  }).sort((a, b) => String(a.pay_date).localeCompare(String(b.pay_date)) || a.store.localeCompare(b.store));
  const sum = (rs, k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
  const tot = rs => {
    const w = sum(rs, 'wages_ex_tips'), tb = sum(rs, 'employer_taxes') + sum(rs, 'benefits');
    return {
      runs: rs.length, gross_wages: r2(sum(rs, 'gross_wages')), tips: r2(sum(rs, 'tips')), wages_ex_tips: r2(w),
      employer_taxes: r2(sum(rs, 'employer_taxes')), benefits: r2(sum(rs, 'benefits')), total_cost: r2(sum(rs, 'total_cost')),
      employer_burden_pct: w ? r2((tb / w) * 100) : null,
    };
  };
  const byStore = {};
  for (const st of [...new Set(out.map(r => r.store))].sort()) byStore[st] = tot(out.filter(r => r.store === st));
  if (fallback.length) notes.push(`Tips unknown for run(s) ${fallback.join(', ')}: wages_ex_tips = gross_wages there, so burden % may be understated if gross includes tips.`);
  return { runs: out, by_store: byStore, totals: out.length ? tot(out) : null, notes };
}

export async function payrollSummary({ from, through, store } = {}, deps = {}) {
  const s = deps.store ?? await mod('./core/store.mjs');
  if (!s) return { empty: true, message: 'ops store not available' };
  const runs = s.query('payroll_runs', { from, through, store, limit: 10000 });
  if (!runs.length) return { from, through, ...(await emptyState(['payroll_runs'], { from, through, store }, deps)) };
  const ids = new Set(runs.map(r => `${r.vendor}\u0000${r.run_id}`));
  const lines = s.query('payroll_lines', { limit: 500000 }).filter(l => ids.has(`${l.vendor}\u0000${l.run_id}`));
  const { notes, ...rest } = computePayroll(runs, lines);
  return {
    from, through, store: store || 'all',
    notes: ['employer_burden_pct = (employer_taxes + benefits) / wages_ex_tips. Tips are shown separately and are not counted as wages. Runs are selected by pay_date.', ...notes],
    ...rest,
  };
}

// ---------------------------------------------------------------- sync
export const DISABLED = 'ops layer disabled (set OPS_ENABLED=true)';
export async function syncNow({ vendor, from, through } = {}, deps = {}) {
  if ((deps.enabled ?? process.env.OPS_ENABLED === 'true') !== true) return { ok: false, disabled: true, error: DISABLED };
  const runner = deps.runner ?? await mod('./core/runner.mjs');
  const range = from || through ? { from, through } : undefined;
  const out = {};
  if (!runner) out.collect = { ok: false, error: 'ops/core/runner.mjs not deployed yet' };
  // runVendorLocked shares runAll's lock, so a one-vendor sync never runs a second browser alongside it.
  else if (vendor && typeof runner.runVendorLocked !== 'function') out.collect = { ok: false, error: 'ops/core/runner.mjs has no runVendorLocked yet (redeploy)' };
  else if (vendor) out.collect = await runner.runVendorLocked(vendor, { range });
  else out.collect = await runner.runAll({ range });
  // runAll sweeps the inbox itself (returns {at, ok, results, inbox}); only sweep here if it didn't.
  if (!vendor && !(out.collect && 'inbox' in out.collect)) {
    const inbox = deps.inbox ?? await mod('./inbox/index.mjs');
    if (!inbox) out.inbox = { ok: false, error: 'ops/inbox/index.mjs not deployed yet' };
    else { try { out.inbox = await inbox.sweepInbox(); } catch (e) { out.inbox = { ok: false, error: e?.message || String(e) }; } }
  }
  return scrub(out);
}

// ---------------------------------------------------------------- registration
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const json = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const safe = fn => async args => {
  try { return json(await fn(args || {})); }
  catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e?.message || String(e) }) }] }; }
};
const KIND_NAMES = ['delivery_orders', 'delivery_payouts', 'labor_shifts', 'schedule_shifts', 'payroll_runs', 'payroll_lines', 'bank_transactions'];

export function registerOpsTools(server, z) {
  const date = d => z.string().regex(DATE, 'YYYY-MM-DD').describe(d);
  const storeArg = z.enum(STORES).optional().describe("Canonical store: 'Montrose' or 'Washington'. Omit for both.");

  server.tool('ops_status',
    'Back-office connector health: per vendor (DoorDash, Uber Eats, Grubhub, Homebase, Toast Payroll, ...) its state, last run, whether a session/credentials are stored and when the session was last pushed. Never returns secrets.',
    {}, safe(() => opsStatus()));

  server.tool('ops_query',
    'Raw normalized rows from the ops store for one record kind (see ops/README.md for columns). Dates are Chicago business dates.',
    {
      kind: z.enum(KIND_NAMES).describe('Record kind'),
      vendor: z.string().optional().describe('Adapter id, e.g. doordash'),
      store: storeArg,
      from: date('On/after YYYY-MM-DD').optional(),
      through: date('On/before YYYY-MM-DD').optional(),
      limit: z.number().int().positive().max(5000).optional().describe('Max rows, default 500'),
    },
    safe(async ({ kind, limit, ...f }) => {
      const s = await mod('./core/store.mjs');
      if (!s) return { empty: true, message: 'ops store not available' };
      const rows = s.query(kind, { ...f, limit: limit ?? 500 });
      return rows.length ? { kind, count: rows.length, rows } : { kind, count: 0, ...(await emptyState([kind], f)) };
    }));

  server.tool('ops_sync_now',
    'Run collectors now. With vendor: just that vendor. Without: every enabled vendor plus a sweep of the vendor report emails inbox. Optional from/through limit the date range collected.',
    { vendor: z.string().optional().describe('Adapter id; omit for all'), from: date('YYYY-MM-DD').optional(), through: date('YYYY-MM-DD').optional() },
    safe(async args => {
      const r = await syncNow(args);
      if (r?.disabled) throw Error(DISABLED);
      return r;
    }));

  server.tool('delivery_summary',
    'Third-party delivery economics per vendor x store: orders, gross subtotal, commission, marketing, error charges, adjustments, net payout, effective take rate %, plus reconciliation of per-order payouts vs deposits reported.',
    { from: date('Business date from, YYYY-MM-DD'), through: date('Business date through, YYYY-MM-DD'), store: storeArg, vendor: z.string().optional().describe('Adapter id, e.g. doordash, ubereats, grubhub') },
    safe(args => deliverySummary(args)));

  server.tool('labor_summary',
    'Actual vs scheduled labor per store per day: hours, cost, variance, overtime hours, and the top overtime employees per store.',
    { from: date('Business date from, YYYY-MM-DD'), through: date('Business date through, YYYY-MM-DD'), store: storeArg, vendor: z.string().optional().describe('Time-punch source adapter id if more than one reports shifts') },
    safe(args => laborSummary(args)));

  server.tool('payroll_summary',
    'Payroll runs with pay_date in range: gross wages, tips, wages excluding tips, employer taxes, benefits, total cost and employer burden % ((employer_taxes + benefits) / wages_ex_tips), per run, per store and overall.',
    { from: date('Pay date from, YYYY-MM-DD'), through: date('Pay date through, YYYY-MM-DD'), store: storeArg },
    safe(args => payrollSummary(args)));
}
