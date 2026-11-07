import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-tools-'));
process.env.OPS_DATA_DIR = dir;
const store = await import('./core/store.mjs');
const { deliverySummary, laborSummary, payrollSummary, computeDelivery, computeLabor, computePayroll, syncNow, opsStatus, emptyState, registerOpsTools, scrub } = await import('./tools.mjs');

test.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const order = (o) => ({ vendor: 'doordash', store: 'Montrose', business_date: '2026-11-01', status: 'delivered', tax: 0, tip: 0, processing_fee: 0, adjustments: 0, error_charges: 0, marketing_fee: 0, channel: 'delivery', ...o });

test('delivery_summary: per vendor x store fees, take rate, reconciliation', async () => {
  store.upsert('delivery_orders', [
    order({ order_id: 'd1', subtotal: 100, commission: 25, processing_fee: 2.5, marketing_fee: 5, payout: 67.5 }),
    order({ order_id: 'd2', subtotal: 50, commission: 12.5, error_charges: 3, adjustments: -1.25, payout: 33.25 }),
    order({ order_id: 'd3', subtotal: 40, commission: 0, payout: 0, status: 'cancelled' }),
    order({ order_id: 'd4', store: 'Washington', subtotal: 80, commission: 20, payout: 60, business_date: '2026-11-02' }),
    order({ order_id: 'u1', vendor: 'ubereats', store: 'Montrose', subtotal: 30.333, commission: 9.1, payout: 21.233 }),
    order({ order_id: 'old', subtotal: 999, commission: 1, payout: 998, business_date: '2026-10-01' }),
  ]);
  store.upsert('delivery_payouts', [
    { vendor: 'doordash', store: 'Montrose', payout_id: 'p1', payout_date: '2026-11-03', net_payout: 100 },
    { vendor: 'doordash', store: 'Washington', payout_id: 'p2', payout_date: '2026-11-03', net_payout: 60 },
  ]);
  const r = await deliverySummary({ from: '2026-11-01', through: '2026-11-07' });
  assert.equal(r.by_vendor_store.length, 3);
  const dm = r.by_vendor_store.find(x => x.vendor === 'doordash' && x.store === 'Montrose');
  assert.equal(dm.orders, 2);
  assert.equal(dm.cancelled, 1);
  assert.equal(dm.gross_subtotal, 150);     // cancelled d3's 40 is not a sale
  assert.equal(dm.commission, 37.5);
  assert.equal(dm.marketing, 5);
  assert.equal(dm.error_charges, 3);
  assert.equal(dm.adjustments, -1.25);
  assert.equal(dm.total_fees, 48);         // 37.5 + 2.5 + 5 + 3
  assert.equal(dm.net_payout, 100.75);
  assert.equal(dm.effective_take_rate_pct, 32); // 48 / 150
  assert.equal(dm.avg_ticket, 75);
  assert.deepEqual(dm.reconciliation, { order_payouts: 100.75, payouts_reported: 100, payout_count: 1, difference: -0.75 });
  const u = r.by_vendor_store.find(x => x.vendor === 'ubereats');
  assert.equal(u.gross_subtotal, 30.33);
  assert.equal(u.effective_take_rate_pct, 30);
  assert.equal(r.totals.orders, 4);
  assert.equal(r.totals.gross_subtotal, 260.33);

  const w = await deliverySummary({ from: '2026-11-01', through: '2026-11-07', store: 'Washington' });
  assert.equal(w.by_vendor_store.length, 1);
  assert.equal(w.by_vendor_store[0].reconciliation.difference, 0);
});

test('computeDelivery: cancelled orders keep only payout, error charges and adjustments', () => {
  const o = (x) => ({ vendor: 'doordash', store: 'Montrose', status: 'delivered', subtotal: 0, tax: 0, tip: 0, commission: 0, processing_fee: 0, marketing_fee: 0, error_charges: 0, adjustments: 0, payout: 0, ...x });
  const { rows } = computeDelivery([
    o({ subtotal: 100, tax: 8, tip: 5, commission: 20, processing_fee: 3, payout: 77 }),
    o({ subtotal: 60, tax: 4.8, tip: 3, commission: 12, processing_fee: 2, marketing_fee: 5, status: 'Cancelled', error_charges: 6, adjustments: 1.5, payout: 10 }),
  ], []);
  const r = rows[0];
  assert.equal(r.orders, 1);
  assert.equal(r.cancelled, 1);
  assert.equal(r.gross_subtotal, 100);
  assert.equal(r.tax, 8);
  assert.equal(r.tip, 5);
  assert.equal(r.commission, 20);
  assert.equal(r.processing_fee, 3);
  assert.equal(r.marketing, 0);
  assert.equal(r.error_charges, 6);      // real money lost on the cancelled order
  assert.equal(r.adjustments, 1.5);
  assert.equal(r.total_fees, 29);         // 20 + 3 + 6
  assert.equal(r.net_payout, 87);         // 77 + 10
  assert.equal(r.effective_take_rate_pct, 23); // completed-order fees 23 / 100
  assert.equal(r.avg_ticket, 100);
});

test('delivery reconciliation leaves out payouts derived from order rows', async () => {
  const o = (x) => ({ vendor: 'grubhub', store: 'Montrose', business_date: '2026-12-01', status: 'delivered', subtotal: 50, commission: 10, payout: 40, ...x });
  const derived = { vendor: 'grubhub', store: 'Montrose', payout_id: 'g-derived', payout_date: '2026-12-02', net_payout: 80, extra: { derived_from_orders: true, order_count: 2 } };
  const only = computeDelivery([o({ order_id: 'a' }), o({ order_id: 'b' })], [derived]).rows[0];
  assert.deepEqual(only.reconciliation, { order_payouts: 80, payouts_reported: null, payout_count: 0, difference: null, derived_payouts_excluded: 1, note: 'payouts derived from order rows — reconcile against bank deposits' });
  const mixed = computeDelivery([o({ order_id: 'a' })], [derived, { vendor: 'grubhub', store: 'Montrose', payout_id: 'real', net_payout: 39 }]).rows[0];
  assert.deepEqual(mixed.reconciliation, { order_payouts: 40, payouts_reported: 39, payout_count: 1, difference: -1, derived_payouts_excluded: 1 });

  store.upsert('delivery_orders', [o({ order_id: 'g1' })]);
  store.upsert('delivery_payouts', [derived]);
  const r = await deliverySummary({ from: '2026-12-01', through: '2026-12-07', vendor: 'grubhub' });
  assert.equal(r.by_vendor_store[0].reconciliation.payouts_reported, null);
  assert.ok(r.notes.some(n => n === 'grubhub: payouts derived from order rows — reconcile against bank deposits. Those payout rows are left out of payouts_reported.'));
});

test('computeDelivery: zero subtotal gives null take rate, not NaN', () => {
  const { rows } = computeDelivery([{ vendor: 'grubhub', store: 'Montrose', status: 'cancelled', subtotal: 0, commission: 0 }], []);
  assert.equal(rows[0].effective_take_rate_pct, null);
  assert.equal(rows[0].avg_ticket, null);
});

test('labor_summary: actual vs scheduled, variance, OT, top OT employees, cost estimate', async () => {
  store.upsert('labor_shifts', [
    { vendor: 'homebase', store: 'Montrose', shift_id: 's1', business_date: '2026-11-01', employee: 'Ana', regular_hours: 8, ot_hours: 2, labor_cost: 190 },
    { vendor: 'homebase', store: 'Montrose', shift_id: 's2', business_date: '2026-11-01', employee: 'Ben', regular_hours: 6, ot_hours: 0, labor_cost: 90 },
    { vendor: 'homebase', store: 'Montrose', shift_id: 's3', business_date: '2026-11-02', employee: 'Ben', regular_hours: 8, ot_hours: 3, wage_rate: 15 },
    { vendor: 'homebase', store: 'Washington', shift_id: 's4', business_date: '2026-11-01', employee: 'Cy', clock_in: '2026-11-01T16:00:00Z', clock_out: '2026-11-01T21:30:00Z', labor_cost: 82.5 },
  ]);
  store.upsert('schedule_shifts', [
    { vendor: 'homebase', store: 'Montrose', shift_id: 'c1', business_date: '2026-11-01', employee: 'Ana', scheduled_hours: 8, scheduled_cost: 152 },
    { vendor: 'homebase', store: 'Montrose', shift_id: 'c2', business_date: '2026-11-01', employee: 'Ben', start: '2026-11-01T17:00:00Z', end: '2026-11-01T22:00:00Z', scheduled_cost: 75 },
  ]);
  const r = await laborSummary({ from: '2026-11-01', through: '2026-11-07' });
  const d1 = r.daily.find(d => d.store === 'Montrose' && d.business_date === '2026-11-01');
  assert.equal(d1.actual_hours, 16);
  assert.equal(d1.scheduled_hours, 13);
  assert.equal(d1.hours_variance, 3);
  assert.equal(d1.actual_cost, 280);
  assert.equal(d1.scheduled_cost, 227);
  assert.equal(d1.cost_variance, 53);
  assert.equal(d1.ot_hours, 2);
  const d2 = r.daily.find(d => d.store === 'Montrose' && d.business_date === '2026-11-02');
  assert.equal(d2.actual_cost, 187.5); // 15*8 + 15*1.5*3
  assert.equal(d2.cost_estimated, true);
  assert.equal(d2.scheduled_hours, 0);
  const wa = r.daily.find(d => d.store === 'Washington');
  assert.equal(wa.actual_hours, 5.5);
  assert.equal(r.by_store.Montrose.ot_hours, 5);
  assert.deepEqual(r.by_store.Montrose.top_ot_employees, [{ employee: 'Ben', ot_hours: 3, shifts_with_ot: 1 }, { employee: 'Ana', ot_hours: 2, shifts_with_ot: 1 }]);
  assert.equal(r.by_store.Montrose.actual_cost, 467.5);
  assert.ok(r.notes.some(n => /estimated/.test(n)));
});

test('computeLabor: ot_hours=0 with no regular_hours falls back to punch times', () => {
  const { daily } = computeLabor([
    { vendor: 'homebase', store: 'Montrose', business_date: '2026-11-01', employee: 'A', regular_hours: null, ot_hours: 0, clock_in: '2026-11-01T16:00:00Z', clock_out: '2026-11-01T22:00:00Z', wage_rate: 10 },
    { vendor: 'homebase', store: 'Montrose', business_date: '2026-11-01', employee: 'B', ot_hours: 1, clock_in: '2026-11-01T12:00:00Z', clock_out: '2026-11-01T21:00:00Z', wage_rate: 20 },
  ], []);
  assert.equal(daily[0].actual_hours, 15);  // 6 + 9 (B's 9 punched hours include its 1 OT hour)
  assert.equal(daily[0].ot_hours, 1);
  assert.equal(daily[0].actual_cost, 250);   // A 10*6 = 60; B 20*(8 + 1.5*1) = 190
});

test('labor_summary: two time-punch vendors for one store are not double counted', async () => {
  store.upsert('labor_shifts', [
    { vendor: 'toast', store: 'Washington', shift_id: 't1', business_date: '2026-11-01', employee: 'Cy', regular_hours: 5.5, labor_cost: 82.5 },
  ]);
  const r = await laborSummary({ from: '2026-11-01', through: '2026-11-01', store: 'Washington' });
  assert.equal(r.daily[0].actual_hours, 5.5);
  assert.ok(r.notes.some(n => /Washington: time punches from/.test(n)));
});

test('payroll_summary: totals and employer burden %', async () => {
  store.upsert('payroll_runs', [
    { vendor: 'toast-payroll', store: 'Montrose', run_id: 'r1', pay_date: '2026-11-06', period_start: '2026-10-20', period_end: '2026-11-02', gross_wages: 20000, employer_taxes: 1530, benefits: 470, total_cost: 22000 },
    { vendor: 'toast-payroll', store: 'Washington', run_id: 'r2', pay_date: '2026-11-06', gross_wages: 10000, employer_taxes: 765, benefits: 0 },
  ]);
  store.upsert('payroll_lines', [
    { vendor: 'toast-payroll', run_id: 'r2', employee: 'A', store: 'Washington', gross_wages: 6000, regular_hours: 300, ot_hours: 4, tips: 100 },
    { vendor: 'toast-payroll', run_id: 'r2', employee: 'B', store: 'Washington', gross_wages: 4000, regular_hours: 200, ot_hours: 1, tips: 50 },
  ]);
  const r = await payrollSummary({ from: '2026-11-01', through: '2026-11-07' });
  assert.equal(r.runs.length, 2);
  const m = r.runs.find(x => x.run_id === 'r1');
  assert.equal(m.employer_burden_pct, 10);
  const w = r.runs.find(x => x.run_id === 'r2');
  assert.equal(w.total_cost, 10765);
  assert.equal(w.tips, 150);              // from payroll_lines
  assert.equal(w.wages_ex_tips, 9850);
  assert.equal(w.employer_burden_pct, 7.77); // 765 / 9850
  assert.equal(w.employee_count, 2);
  assert.equal(w.ot_hours, 5);
  assert.equal(r.totals.gross_wages, 30000);
  assert.equal(r.totals.total_cost, 32765);
  assert.equal(r.totals.wages_ex_tips, 29850);
  assert.equal(r.totals.employer_burden_pct, 9.26); // (1530 + 470 + 765) / 29850
  assert.equal(m.wages_ex_tips_source, 'gross_wages (tips unknown)');
  assert.ok(r.notes.some(n => /Tips unknown for run\(s\) r1/.test(n)));
  assert.equal(r.by_store.Washington.runs, 1);
});

test('computePayroll: tips are not wages — extra.wages_ex_tips, then extra.tips, then line tips', () => {
  const run = (x) => ({ vendor: 'toast-payroll', store: 'Montrose', pay_date: '2026-11-06', gross_wages: 12000, employer_taxes: 765, benefits: 235, ...x });
  const { runs, totals } = computePayroll([
    run({ run_id: 'a', extra: { wages_ex_tips: 10000, tips: 2000 } }),
    run({ run_id: 'b', extra: { tips: 2000 } }),
    run({ run_id: 'c' }),
  ], [{ vendor: 'toast-payroll', run_id: 'c', employee: 'X', tips: 1500 }, { vendor: 'toast-payroll', run_id: 'c', employee: 'Y', tips: 500 }]);
  for (const r of runs) {
    assert.equal(r.gross_wages, 12000);
    assert.equal(r.tips, 2000);
    assert.equal(r.wages_ex_tips, 10000);
    assert.equal(r.total_cost, 13000);
    assert.equal(r.employer_burden_pct, 10); // (765 + 235) / 10000, not 1000 / 12000
  }
  assert.deepEqual(runs.map(r => r.wages_ex_tips_source), ['run', 'run tips', 'payroll_lines tips']);
  assert.equal(totals.tips, 6000);
  assert.equal(totals.employer_burden_pct, 10);
});

test('syncNow: disabled unless OPS_ENABLED=true; one vendor goes through runVendorLocked', async () => {
  const prev = process.env.OPS_ENABLED;
  try {
    process.env.OPS_ENABLED = 'false';
    const never = { runVendor: () => assert.fail(), runVendorLocked: () => assert.fail(), runAll: () => assert.fail() };
    assert.deepEqual(await syncNow({ vendor: 'doordash' }, { runner: never }), { ok: false, disabled: true, error: 'ops layer disabled (set OPS_ENABLED=true)' });
    const tools = {};
    const { z } = await import('zod');
    registerOpsTools({ tool: (name, _d, _s, fn) => { tools[name] = fn; } }, z);
    const t = await tools.ops_sync_now({});
    assert.equal(t.isError, true);
    assert.match(t.content[0].text, /ops layer disabled \(set OPS_ENABLED=true\)/);

    process.env.OPS_ENABLED = 'true';
    const calls = [];
    const runner = { runVendor: () => assert.fail('unlocked runVendor'), runVendorLocked: async (id, o) => { calls.push([id, o]); return { vendor: id, ok: true }; } };
    assert.deepEqual(await syncNow({ vendor: 'doordash', from: '2026-11-01' }, { runner }), { collect: { vendor: 'doordash', ok: true } });
    assert.deepEqual(calls, [['doordash', { range: { from: '2026-11-01', through: undefined } }]]);
    const old = await syncNow({ vendor: 'doordash' }, { runner: { runVendor: () => assert.fail('unlocked runVendor') } });
    assert.match(old.collect.error, /runVendorLocked/);
  } finally { if (prev === undefined) delete process.env.OPS_ENABLED; else process.env.OPS_ENABLED = prev; }
});

test('empty state names the vendor and why (from health)', async () => {
  const deps = {
    store,
    registry: { adapters: async () => Object.assign([{ id: 'grubhub', name: 'Grubhub', kinds: ['delivery_orders'], modes: ['session'] }], { errors: [] }) },
    health: { opsHealth: async () => ({ state: 'ALERT', enabled: true, vendors: [{ vendor: 'grubhub', problems: ['no stored session — needs handoff'] }], problems: ['grubhub: no stored session — needs handoff'] }) },
    vault: { listVault: () => [] },
  };
  const r = await deliverySummary({ from: '2027-01-01', through: '2027-01-07' }, deps);
  assert.equal(r.empty, true);
  assert.match(r.message, /Grubhub: no stored session — needs handoff/);
  const e = await emptyState(['payroll_runs'], {}, deps);
  assert.match(e.message, /no registered vendor produces payroll_runs/);
});

test('ops_status merges health + vault per vendor and never leaks secrets', async () => {
  const s = await opsStatus({
    store,
    health: { opsHealth: async () => ({ state: 'ok', enabled: true, vendors: [{ vendor: 'doordash', name: 'DoorDash', problems: [], password: 'x' }], problems: [] }) },
    vault: { listVault: () => [{ vendor: 'doordash', hasCreds: true, hasSession: true, sessionSavedAt: '2026-11-06T09:00:00Z', sessionSource: 'handoff' }] },
  });
  const dd = s.vendors.find(v => v.vendor === 'doordash');
  assert.equal(dd.vault.sessionSource, 'handoff');
  assert.equal(dd.password, undefined);
  assert.equal(JSON.stringify(scrub({ a: { token: 't', cookies: [1], ok: 1 } })), '{"a":{"ok":1}}');
});

test('registerOpsTools registers all six tools with zod shapes', async () => {
  const { z } = await import('zod');
  const names = [];
  registerOpsTools({ tool: (name, desc, shape, fn) => { assert.equal(typeof desc, 'string'); assert.equal(typeof shape, 'object'); assert.equal(typeof fn, 'function'); names.push(name); } }, z);
  assert.deepEqual(names, ['ops_status', 'ops_query', 'ops_sync_now', 'delivery_summary', 'labor_summary', 'payroll_summary']);
});
