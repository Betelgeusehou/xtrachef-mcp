// node --test ops/vendors/delivery.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import doordash, * as dd from './doordash.mjs';
import ubereats, * as ue from './ubereats.mjs';
import grubhub, * as gh from './grubhub.mjs';
import {
  money, moneyObject, resolveTime, businessDate, addDays, chicagoToIso, toDate, csvRows, expectedPayout, dateWindows, normHeader,
} from './_delivery-common.mjs';
import { KINDS } from '../core/store.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'delivery');
const fx = f => fs.readFileSync(path.join(dir, f));
const json = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const byId = (recs, id) => recs.find(r => r.order_id === id || r.payout_id === id);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 0.01, `${msg}: ${a} vs ${b}`);

// ------------------------------------------------------------------ contract --
describe('adapter contract', () => {
  for (const a of [doordash, ubereats, grubhub]) {
    test(a.id, () => {
      assert.equal(a.domain, 'delivery');
      assert.deepEqual(a.modes, ['session', 'inbox', 'drive']);
      assert.deepEqual(a.kinds, ['delivery_orders', 'delivery_payouts']);
      assert.match(a.loginUrl, /^https:\/\//);
      assert.ok(Array.isArray(a.handoffDomains) && a.handoffDomains.length);
      for (const fn of ['isLoggedIn', 'collect', 'matchFile', 'parseFile']) assert.equal(typeof a[fn], 'function', fn);
      assert.equal(a.login, undefined, 'no headless login for delivery portals');
    });
  }
  test('ids', () => assert.deepEqual([doordash.id, ubereats.id, grubhub.id], ['doordash', 'ubereats', 'grubhub']));
});

// Every record uses only KINDS columns (+extra) and carries its natural key.
function assertRecordShape(res) {
  for (const kind of ['delivery_orders', 'delivery_payouts']) {
    for (const r of res[kind]) {
      for (const k of Object.keys(r)) assert.ok(KINDS[kind].cols.includes(k) || k === 'extra', `${kind} has unknown field ${k}`);
      for (const k of KINDS[kind].key) assert.ok(r[k], `${kind} missing key ${k}`);
      assert.ok(['Montrose', 'Washington'].includes(r.store));
      for (const [k, v] of Object.entries(r)) if (typeof v === 'number') assert.equal(v, Math.round(v * 100) / 100, `${k} not 2dp`);
    }
  }
  assert.deepEqual(Object.keys(res), ['delivery_orders', 'delivery_payouts'], 'only record kinds are enumerable');
}

// -------------------------------------------------------------------- common --
describe('money', () => {
  test('formats', () => {
    assert.equal(money('$1,234.56'), 1234.56);
    assert.equal(money('(12.00)'), -12);
    assert.equal(money('($2.89)'), -2.89);
    assert.equal(money('-12.00'), -12);
    assert.equal(money('-$3.00'), -3);
    assert.equal(money('$-3.00'), -3);
    assert.equal(money('12.50-'), -12.5);
    assert.equal(money(' 7 '), 7);
    assert.equal(money(''), null);
    assert.equal(money('N/A'), null);
    assert.equal(money('abc'), null);
    assert.equal(money(0.1 + 0.2), 0.3);
  });
  test('json money objects', () => {
    assert.equal(moneyObject({ unit_amount: 4000, currency: 'USD' }), 40);
    assert.equal(moneyObject({ amountE5: 248000, currencyCode: 'USD' }), 2.48);
    assert.equal(moneyObject({ units: 5, nanos: 500000000 }), 5.5);
    assert.equal(moneyObject({ amount_cents: -289 }), -2.89);
    assert.equal(moneyObject({ amount: '$3.10' }), 3.1);
  });
});

describe('business date (America/Chicago, 4am cutoff)', () => {
  test('before 4am belongs to the previous day', () => {
    assert.equal(businessDate({ y: 2026, m: 11, d: 3 }, { h: 1, mi: 40 }), '2026-11-02');
    assert.equal(businessDate({ y: 2026, m: 11, d: 3 }, { h: 3, mi: 59, s: 59 }), '2026-11-02');
    assert.equal(businessDate({ y: 2026, m: 11, d: 3 }, { h: 4, mi: 0 }), '2026-11-03');
    assert.equal(businessDate({ y: 2026, m: 11, d: 3 }, { h: 0, mi: 0 }), '2026-11-02');
    assert.equal(businessDate({ y: 2026, m: 3, d: 1 }, { h: 2 }), '2026-02-28');
    assert.equal(businessDate({ y: 2027, m: 1, d: 1 }, { h: 1 }), '2026-12-31');
  });
  test('local strings in several formats', () => {
    assert.equal(resolveTime({ localDate: '11/03/2026', localTime: '12:45 AM' }).business_date, '2026-11-02');
    assert.equal(resolveTime({ localDate: '11/03/2026', localTime: '12:45 PM' }).business_date, '2026-11-03');
    assert.equal(resolveTime({ localDate: '2026-11-03 01:20:00' }).business_date, '2026-11-02');
    assert.equal(resolveTime({ localDate: 'Nov 3, 2026', localTime: '9:00 PM' }).business_date, '2026-11-03');
    assert.equal(resolveTime({ localDate: '11/3/26' }).business_date, '2026-11-03'); // no time -> same day
  });
  test('UTC timestamps convert through Chicago time (CST and CDT)', () => {
    // 2026-11-04T07:15Z = 01:15 CST Nov 4 -> business date Nov 3
    assert.equal(resolveTime({ utc: '2026-11-04T07:15:00Z' }).business_date, '2026-11-03');
    // 2026-07-04T08:30Z = 03:30 CDT Jul 4 -> Jul 3
    assert.equal(resolveTime({ utc: '2026-07-04T08:30:00Z' }).business_date, '2026-07-03');
    // 2026-07-04T09:30Z = 04:30 CDT -> Jul 4
    assert.equal(resolveTime({ utc: '2026-07-04T09:30:00Z' }).business_date, '2026-07-04');
    assert.equal(resolveTime({ utc: Date.parse('2026-11-04T07:15:00Z') }).business_date, '2026-11-03');
  });
  test('placed_at is the UTC instant of the Chicago wall time', () => {
    assert.equal(chicagoToIso({ y: 2026, m: 11, d: 3 }, { h: 1, mi: 40 }), '2026-11-03T07:40:00.000Z');
    assert.equal(chicagoToIso({ y: 2026, m: 7, d: 3 }, { h: 21 }), '2026-07-04T02:00:00.000Z');
    assert.equal(resolveTime({ localDate: '2026-11-02', localTime: '19:15:00' }).placed_at, '2026-11-03T01:15:00.000Z');
  });
  test('date helpers', () => {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(toDate('11/09/2026'), '2026-11-09');
    assert.deepEqual(dateWindows({ from: '2026-10-01', through: '2026-11-15' }, 31), [
      { from: '2026-10-01', through: '2026-10-31' }, { from: '2026-11-01', through: '2026-11-15' }]);
  });
});

describe('csv header detection', () => {
  test('skips title rows, BOM, normalizes headers', () => {
    const text = '﻿DoorDash Financial Report\nGenerated 11/07/2026\nStore name,DoorDash order ID,Net total\nBetelgeuse - Montrose,x1,$5.00\n';
    const { headers, rows } = csvRows(text, ['Store name', 'DoorDash order ID', 'Net total']);
    assert.deepEqual(headers, ['storename', 'doordashorderid', 'nettotal']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].nettotal, '$5.00');
  });
  test('normHeader', () => {
    assert.equal(normHeader('Subtotal tax passed to merchant'), normHeader('subtotal_tax_passed_to_merchant'));
    assert.equal(normHeader('subtotalTaxPassedToMerchant'), normHeader('Subtotal Tax Passed To Merchant'));
    assert.equal(normHeader('Marketplace fee %'), 'marketplacefeepct');
  });
});

// ------------------------------------------------------------------ DoorDash --
describe('doordash parseFile', () => {
  const res = doordash.parseFile(fx('doordash-transactions.csv'), { filename: 'financial_detailed_transactions_2026-11-02.csv' });
  test('counts and skips', () => {
    assert.equal(res.stats.report, 'orders');
    assert.equal(res.delivery_orders.length, 5); // 0001 (+error charge), 0002, 0003 (+adjustment), 0004, 0006
    assert.equal(res.stats.skipped_store, 1);
    assert.deepEqual(res.stats.unmapped_stores, ['Betelgeuse Katy']);
    assert.equal(res.stats.non_order_rows, 1); // AD_FEE
    assertRecordShape(res);
  });
  test('store mapping incl. Endless Bummer -> Montrose', () => {
    assert.equal(byId(res.delivery_orders, 'a1f0c2d4-0002').store, 'Washington');
    assert.equal(byId(res.delivery_orders, 'a1f0c2d4-0006').store, 'Montrose');
  });
  test('after-midnight order goes to previous business date', () => {
    const o = byId(res.delivery_orders, 'a1f0c2d4-0002');
    assert.equal(o.business_date, '2026-11-02');
    assert.equal(o.placed_at, '2026-11-03T07:40:00.000Z');
    assert.equal(byId(res.delivery_orders, 'a1f0c2d4-0004').business_date, '2026-11-03'); // 03:59
  });
  test('error charge row merges into its order', () => {
    const o = byId(res.delivery_orders, 'a1f0c2d4-0001');
    assert.equal(o.error_charges, 8.5);
    assert.equal(o.payout, 22.1);
    assert.equal(o.commission, 6);
    assert.equal(o.status, 'Delivered');
    assert.equal(o.business_date, '2026-11-02');
    assert.deepEqual(o.extra.row_types, ['DELIVERY', 'ERROR_CHARGE']);
  });
  test('adjustment + merchant-funded discount', () => {
    const o = byId(res.delivery_orders, 'a1f0c2d4-0003');
    assert.equal(o.adjustments, 3);
    assert.equal(o.marketing_fee, 6.25);
  });
  test('every order reconciles: payout = subtotal+tax+tip-fees-errors+adjustments', () => {
    for (const o of res.delivery_orders) {
      near(o.payout, expectedPayout(o), o.order_id);
      assert.equal(o.extra.warnings, undefined, `${o.order_id} warnings ${o.extra.warnings}`);
    }
  });
  const pay = doordash.parseFile(fx('doordash-payouts.csv'), { filename: 'payout_summary.csv' });
  test('payouts report', () => {
    assert.equal(pay.stats.report, 'payouts');
    assert.equal(pay.delivery_payouts.length, 2);
    assert.equal(pay.stats.skipped_store, 1);
    assertRecordShape(pay);
    const m = byId(pay.delivery_payouts, 'P-M-1001');
    assert.deepEqual([m.store, m.payout_date, m.period_start, m.period_end], ['Montrose', '2026-11-10', '2026-11-02', '2026-11-08']);
    for (const p of pay.delivery_payouts) near(p.net_payout, p.gross_sales - p.total_fees + p.adjustments, p.payout_id);
  });
  test('orders file and payouts file agree per payout', () => {
    for (const p of pay.delivery_payouts) {
      const orders = res.delivery_orders.filter(o => o.extra.payout_id === p.payout_id);
      const adFees = p.payout_id === 'P-M-1001' ? -25 : 0; // AD_FEE row is payout-level
      near(orders.reduce((a, o) => a + o.payout, 0) + adFees, p.net_payout, p.payout_id);
    }
  });
  test('tax: passed-to-merchant column wins; else tax_subtotal minus remitted', () => {
    const csv = 'Store name,DoorDash order ID,Timestamp local date,Timestamp local time,Subtotal,Tax subtotal,Subtotal tax remitted by DoorDash to tax authorities,Net total\nBetelgeuse - Montrose,z1,2026-11-02,20:00,10.00,0.83,0.83,10.00\n';
    const r = doordash.parseFile(Buffer.from(csv));
    assert.equal(r.delivery_orders[0].tax, 0);
    assert.equal(r.delivery_orders[0].extra.tax_collected, 0.83);
  });
  test('item-level Order Details report is recognised and ignored', () => {
    const r = doordash.parseFile(Buffer.from('business_id,store_id,dd_order_number,order_item_id,store_name,subtotal\n1,2,3,4,Betelgeuse - Montrose,5\n'));
    assert.equal(r.stats.report, 'order_items');
    assert.equal(r.delivery_orders.length, 0);
  });
});

describe('doordash matchFile', () => {
  test('true', () => {
    assert.ok(doordash.matchFile({ from: 'DoorDash <no-reply@doordash.com>', filename: 'report.csv', mimeType: 'text/csv' }));
    assert.ok(doordash.matchFile({ from: 'reports@merchant.doordash.com', filename: 'x.csv' }));
    assert.ok(doordash.matchFile({ from: 'chris@betelgeusehou.com', filename: 'doordash_financial_transactions_breakdown.csv' }));
    assert.ok(doordash.matchFile({ from: '', filename: 'FINANCIAL_DETAILED_TRANSACTIONS.csv', subject: 'Your DoorDash report is ready' }));
  });
  test('false', () => {
    assert.ok(!doordash.matchFile({ from: 'no-reply@doordash.com', filename: 'statement.pdf', mimeType: 'application/pdf' }));
    assert.ok(!doordash.matchFile({ from: 'noreply@uber.com', filename: 'payment_details.csv' }));
    assert.ok(!doordash.matchFile({ from: 'x@notdoordash.com', filename: 'transactions.csv' }));
    assert.ok(!doordash.matchFile({ from: 'chris@betelgeusehou.com', filename: 'Invoices_2026.csv' }));
  });
});

// ------------------------------------------------------------------ Uber Eats --
describe('ubereats parseFile', () => {
  const res = ubereats.parseFile(fx('ubereats-payment-details.csv'), { filename: 'Payment_details_2026-11-02.csv' });
  test('counts, description row, unmapped store, store-level row', () => {
    assert.equal(res.stats.report, 'orders');
    assert.equal(res.stats.description_rows, 1);
    assert.equal(res.delivery_orders.length, 4);
    assert.equal(res.stats.skipped_store, 1);
    assert.deepEqual(res.stats.unmapped_stores, ['Betelgeuse Pop-Up']);
    assert.equal(res.stats.non_order_rows, 1);
    assertRecordShape(res);
  });
  test('order_id is the Workflow ID; display id kept in extra', () => {
    const o = byId(res.delivery_orders, 'wf-11111111-aaaa');
    assert.equal(o.extra.display_order_id, '3F2A1');
    assert.equal(o.store, 'Montrose');
  });
  test('12:45 AM order -> previous business date', () => {
    const o = byId(res.delivery_orders, 'wf-22222222-bbbb');
    assert.equal(o.business_date, '2026-11-02');
    assert.equal(o.placed_at, '2026-11-03T06:45:00.000Z');
  });
  test('marketplace facilitator tax nets tax; promotions are marketing', () => {
    const o = byId(res.delivery_orders, 'wf-11111111-aaaa');
    assert.equal(o.tax, 0.25); // 2.48 tax - 2.23 MF tax
    assert.equal(o.marketing_fee, 3.25);
    assert.equal(o.commission, 9);
  });
  test('refund is an error charge', () => {
    const o = byId(res.delivery_orders, 'wf-33333333-cccc');
    assert.equal(o.error_charges, 6.5);
    assert.equal(o.payout, 6.1);
  });
  test('every order reconciles', () => {
    for (const o of res.delivery_orders) { near(o.payout, expectedPayout(o), o.order_id); assert.equal(o.extra.warnings, undefined); }
  });
  test('payouts derived from Payout reference ID include store-level ad spend', () => {
    assert.equal(res.delivery_payouts.length, 2);
    const m = byId(res.delivery_payouts, 'PR-M-77');
    assert.equal(m.net_payout, 10.75); // 18 + 12.75 - 20 ads
    assert.equal(m.extra.derived_from_orders, true);
    for (const p of res.delivery_payouts) near(p.net_payout, p.gross_sales - p.total_fees + p.adjustments, p.payout_id);
  });
  const sum = ubereats.parseFile(fx('ubereats-payout-summary.csv'), { filename: 'payout_summary.csv' });
  test('payout summary file matches derived payouts', () => {
    assert.equal(sum.stats.report, 'payouts');
    assertRecordShape(sum);
    for (const p of sum.delivery_payouts) {
      const d = byId(res.delivery_payouts, p.payout_id);
      near(p.net_payout, d.net_payout, p.payout_id);
      near(p.gross_sales, d.gross_sales, p.payout_id + ' gross');
      near(p.total_fees, d.total_fees, p.payout_id + ' fees');
      assert.equal(p.period_end, '2026-11-08');
    }
  });
});

describe('ubereats matchFile', () => {
  test('true', () => {
    assert.ok(ubereats.matchFile({ from: 'Uber Eats <noreply@uber.com>', filename: 'report.csv' }));
    assert.ok(ubereats.matchFile({ from: 'no-reply@ubereats.com', filename: 'x.csv', mimeType: 'text/csv' }));
    assert.ok(ubereats.matchFile({ from: 'ops@betelgeusehou.com', filename: 'UberEats_Payment_details_Nov.csv' }));
    assert.ok(ubereats.matchFile({ from: 'ops@betelgeusehou.com', filename: 'payment_details.csv', subject: 'Uber Eats report' }));
  });
  test('false', () => {
    assert.ok(!ubereats.matchFile({ from: 'ops@betelgeusehou.com', filename: 'payment_details.csv' }));
    assert.ok(!ubereats.matchFile({ from: 'noreply@uber.com', filename: 'invoice.pdf' }));
    assert.ok(!ubereats.matchFile({ from: 'no-reply@doordash.com', filename: 'transactions.csv' }));
  });
});

// -------------------------------------------------------------------- Grubhub --
describe('grubhub parseFile', () => {
  const res = grubhub.parseFile(fx('grubhub-transactions.csv'), { filename: 'grubhub_transactions.csv' });
  test('counts; Total footer skipped', () => {
    assert.equal(res.stats.report, 'orders');
    assert.equal(res.delivery_orders.length, 3);
    assert.equal(res.stats.skipped_other, 1);
    assertRecordShape(res);
  });
  test('adjustment and error charge merge into orders', () => {
    const m = byId(res.delivery_orders, '1001-2345');
    assert.equal(m.adjustments, 2);
    assert.equal(m.payout, 26.88);
    assert.equal(m.commission, 8.75); // marketing + delivery commission
    assert.equal(m.status, 'prepaid order');
    const w = byId(res.delivery_orders, '1001-2399');
    assert.equal(w.error_charges, 6);
    assert.equal(w.payout, 21.5);
  });
  test('1:15 AM order -> previous business date', () => {
    assert.equal(byId(res.delivery_orders, '1001-2399').business_date, '2026-11-03');
  });
  test('withheld tax nets out; promo is marketing', () => {
    const o = byId(res.delivery_orders, '1001-2477');
    assert.equal(o.tax, 0);
    assert.equal(o.marketing_fee, 5);
  });
  test('every order reconciles', () => {
    for (const o of res.delivery_orders) { near(o.payout, expectedPayout(o), o.order_id); assert.equal(o.extra.warnings, undefined); }
  });
  const dep = grubhub.parseFile(fx('grubhub-deposits.csv'), { filename: 'grubhub_deposits.csv' });
  test('deposits file matches payouts derived from transactions', () => {
    assert.equal(dep.stats.report, 'payouts');
    assertRecordShape(dep);
    for (const p of dep.delivery_payouts) {
      const d = byId(res.delivery_payouts, p.payout_id);
      near(p.net_payout, d.net_payout, p.payout_id);
      near(p.gross_sales, d.gross_sales, p.payout_id + ' gross');
      near(p.total_fees, d.total_fees, p.payout_id + ' fees');
      near(p.net_payout, p.gross_sales - p.total_fees + p.adjustments, p.payout_id + ' internal');
    }
  });
});

describe('grubhub matchFile', () => {
  test('true', () => {
    assert.ok(grubhub.matchFile({ from: 'Grubhub <restaurants@grubhub.com>', filename: 'report.csv' }));
    assert.ok(grubhub.matchFile({ from: 'ops@betelgeusehou.com', filename: 'Grubhub_Transactions_2026-11.csv' }));
    assert.ok(grubhub.matchFile({ from: 'ops@betelgeusehou.com', filename: 'transactions.csv', subject: 'Fwd: Grubhub transactions' }));
  });
  test('false', () => {
    assert.ok(!grubhub.matchFile({ from: 'ops@betelgeusehou.com', filename: 'transactions.csv' }));
    assert.ok(!grubhub.matchFile({ from: 'restaurants@grubhub.com', filename: 'statement.pdf' }));
    assert.ok(!grubhub.matchFile({ from: 'noreply@uber.com', filename: 'payment_details.csv' }));
  });
});

// cross-vendor: each parser ignores the others' files
test('parsers do not claim other vendors files', () => {
  assert.equal(doordash.parseFile(fx('ubereats-payment-details.csv')).delivery_orders.length, 0);
  assert.equal(ubereats.parseFile(fx('doordash-transactions.csv')).delivery_orders.length, 0);
  assert.equal(grubhub.parseFile(fx('doordash-payouts.csv')).delivery_payouts.length, 0);
});

// --------------------------------------------------------------- session mode --
// Fake ctx: api() routes by URL (and JSON body) into the JSON fixtures.
function fakeCtx(route, extra = {}) {
  const calls = [];
  const logs = [];
  return {
    calls, logs,
    log: m => logs.push(m),
    async api(url, init = {}) {
      const u = new URL(url);
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ url, method: init.method, body });
      const r = route(u, body);
      if (r === undefined) throw Object.assign(Error(`404 ${url}`), { status: 404 });
      return structuredClone(r);
    },
    ...extra,
  };
}

describe('doordash collect (session)', () => {
  const api = json('doordash-api.json');
  const route = (u) => {
    if (u.pathname.endsWith('/stores')) return api.stores;
    const store = u.searchParams.get('store_id');
    if (u.pathname.endsWith('/transactions')) return api.transactions[store][u.searchParams.get('cursor') === 'c2' ? 1 : 0];
    if (u.pathname.endsWith('/payouts')) return api.payouts[store];
  };
  test('maps JSON with the same normalizer, paginates by cursor', async () => {
    const ctx = fakeCtx(route);
    const res = await doordash.collect(ctx, { from: '2026-11-02', through: '2026-11-08' });
    assertRecordShape(res);
    assert.equal(res.delivery_orders.length, 3);
    assert.equal(ctx.calls.filter(c => c.url.includes('/transactions') && c.url.includes('store_id=24001')).length, 2);
    const o1 = byId(res.delivery_orders, 'a1f0c2d4-0001');
    assert.deepEqual([o1.subtotal, o1.commission, o1.error_charges, o1.payout, o1.store], [40, 6, 8.5, 22.1, 'Montrose']);
    assert.equal(byId(res.delivery_orders, 'a1f0c2d4-0002').business_date, '2026-11-02');
    for (const o of res.delivery_orders) near(o.payout, expectedPayout(o), o.order_id);
    assert.equal(res.delivery_payouts.length, 2);
    for (const p of res.delivery_payouts) {
      const sumOrders = res.delivery_orders.filter(o => o.extra.payout_id === p.payout_id).reduce((a, o) => a + o.payout, 0);
      near(sumOrders, p.net_payout, p.payout_id);
    }
  });
  test('shape change throws a descriptive error flagged for fallback', async () => {
    const ctx = fakeCtx(u => (u.pathname.endsWith('/stores') ? api.stores : { rows: [] }));
    await assert.rejects(doordash.collect(ctx, { from: '2026-11-02', through: '2026-11-08' }), e => {
      assert.match(e.message, /endpoint shape changed: missing transactions/);
      assert.equal(e.shapeChanged, true);
      return true;
    });
    assert.ok(ctx.logs.some(l => /trying report download/.test(l)));
  });
  test('item missing required fields -> shape changed', async () => {
    const ctx = fakeCtx(u => (u.pathname.endsWith('/stores') ? api.stores : u.pathname.endsWith('/transactions') ? { transactions: [{ foo: 1 }] } : api.payouts['24001']));
    await assert.rejects(doordash.collect(ctx, { from: '2026-11-02', through: '2026-11-02' }), /missing doordash_order_id/);
  });
  test('falls back to downloading the CSV report through the UI', async () => {
    const files = { 0: fx('doordash-transactions.csv'), 1: fx('doordash-payouts.csv') };
    let n = 0;
    const clicks = [];
    const page = {
      async goto() {}, async reload() {}, async waitForTimeout() {},
      url: () => 'https://merchant-portal.doordash.com/merchant/reports',
      locator: sel => ({ first: () => ({ click: async () => clicks.push(sel), fill: async () => {}, selectOption: async () => {}, waitFor: async () => {}, count: async () => 1 }) }),
      async waitForEvent(ev) {
        assert.equal(ev, 'download');
        await new Promise(r => setTimeout(r, 5));
        const buf = files[n++];
        return { createReadStream: async () => Readable.from([buf]), suggestedFilename: () => `doordash_${n}.csv` };
      },
    };
    const ctx = fakeCtx(() => { throw Object.assign(Error('HTTP 404'), { status: 404 }); }, { page });
    const res = await doordash.collect(ctx, { from: '2026-11-02', through: '2026-11-08' });
    assert.equal(res.stats.fallback, 'ui_download');
    assert.equal(res.delivery_orders.length, 5);
    assert.equal(res.delivery_payouts.length, 2);
    assert.ok(clicks.some(c => /Transactions breakdown/.test(c)));
  });
});

describe('ubereats collect (session)', () => {
  const api = json('ubereats-api.json');
  const route = (u, body) => {
    if (u.pathname.endsWith('/getStores')) return api.stores;
    const store = body.storeUUIDs?.[0];
    if (u.pathname.endsWith('/getPaymentDetails')) return api.paymentDetails[store][body.cursor === 'p2' ? 1 : 0];
    if (u.pathname.endsWith('/getPayouts')) return api.payouts[store];
  };
  test('maps JSON (amountE5 + plain numbers), cursor pagination, payouts', async () => {
    const ctx = fakeCtx(route);
    const res = await ubereats.collect(ctx, { from: '2026-11-02', through: '2026-11-08' });
    assertRecordShape(res);
    assert.equal(res.delivery_orders.length, 3);
    const m = byId(res.delivery_orders, 'wf-11111111-aaaa');
    assert.deepEqual([m.subtotal, m.tax, m.commission, m.marketing_fee, m.payout], [30, 0.25, 9, 3.25, 18]);
    assert.equal(byId(res.delivery_orders, 'wf-22222222-bbbb').business_date, '2026-11-02');
    assert.equal(byId(res.delivery_orders, 'wf-33333333-cccc').error_charges, 6.5);
    for (const o of res.delivery_orders) near(o.payout, expectedPayout(o), o.order_id);
    // Washington payout comes from the payouts endpoint (with period), Montrose is derived
    const w = byId(res.delivery_payouts, 'PR-W-88');
    assert.deepEqual([w.period_start, w.period_end, w.net_payout], ['2026-11-02', '2026-11-08', 21.5]);
    assert.equal(w.extra.derived_from_orders, undefined);
    assert.equal(byId(res.delivery_payouts, 'PR-M-77').extra.derived_from_orders, true);
    assert.ok(ctx.calls.every(c => c.method === 'POST'));
  });
  test('shape change', async () => {
    const ctx = fakeCtx((u, b) => (u.pathname.endsWith('/getStores') ? api.stores : { data: { orders: [{ id: 'x' }] } }));
    await assert.rejects(ubereats.collect(ctx, { from: '2026-11-02', through: '2026-11-08' }), e => /endpoint shape changed: paymentDetails: item missing workflowId/.test(e.message) && e.shapeChanged);
  });
  test('stores endpoint gone -> shape changed', async () => {
    const ctx = fakeCtx(() => ({ error: 'nope' }));
    await assert.rejects(ubereats.collect(ctx, { from: '2026-11-02', through: '2026-11-08' }), /endpoint shape changed: missing stores/);
  });
});

describe('grubhub collect (session)', () => {
  const api = json('grubhub-api.json');
  const route = u => {
    const m = u.pathname.match(/restaurants\/([^/]+)\/reports\/financials\/(\w+)/);
    if (!m) return u.pathname.endsWith('/restaurants') ? api.restaurants : undefined;
    return api[m[2]][m[1]];
  };
  test('maps JSON (amount_cents + numbers + UTC timestamps), passes bearer token', async () => {
    const page = { evaluate: async () => 'abc.def.ghi', url: () => 'https://restaurant.grubhub.com/dashboard' };
    const ctx = fakeCtx(route, { page });
    const seen = [];
    const api0 = ctx.api;
    ctx.api = (url, init) => { seen.push(init.headers?.authorization); return api0(url, init); };
    const res = await grubhub.collect(ctx, { from: '2026-11-02', through: '2026-11-08' });
    assertRecordShape(res);
    assert.ok(seen.every(h => h === 'Bearer abc.def.ghi'));
    assert.equal(res.delivery_orders.length, 2);
    const m = byId(res.delivery_orders, '1001-2345');
    assert.deepEqual([m.subtotal, m.tax, m.commission, m.processing_fee, m.payout], [35, 0, 8.75, 1.37, 24.88]);
    assert.equal(m.business_date, '2026-11-02'); // 02:05Z = 20:05 CST Nov 2
    assert.equal(byId(res.delivery_orders, '1001-2399').business_date, '2026-11-03'); // 07:15Z = 01:15 CST Nov 4
    for (const o of res.delivery_orders) near(o.payout, expectedPayout(o), o.order_id);
    assert.equal(res.delivery_payouts.length, 2);
    assert.equal(byId(res.delivery_payouts, 'D-55502').period_end, '2026-11-08');
  });
  test('shape change', async () => {
    const ctx = fakeCtx(u => (u.pathname.endsWith('/restaurants') ? api.restaurants : { transactions: [{ order_number: '1' }] }));
    await assert.rejects(grubhub.collect(ctx, { from: '2026-11-02', through: '2026-11-08' }), e => /endpoint shape changed: transactions: item missing restaurant_total/.test(e.message) && e.shapeChanged);
  });
});

describe('isLoggedIn', () => {
  const page = (url, count = 1) => ({ url: () => url, locator: () => ({ count: async () => count }) });
  test('doordash', async () => {
    assert.equal(await doordash.isLoggedIn({ page: page('https://merchant-portal.doordash.com/merchant/sales?store_id=1') }), true);
    assert.equal(await doordash.isLoggedIn({ page: page('https://identity.doordash.com/auth?client_id=x') }), false);
    assert.equal(await doordash.isLoggedIn({ page: page('https://merchant-portal.doordash.com/merchant/sales', 0) }), false);
    assert.equal(await doordash.isLoggedIn({}), false);
  });
  test('ubereats', async () => {
    assert.equal(await ubereats.isLoggedIn({ page: page('https://merchants.ubereats.com/manager/home/abc') }), true);
    assert.equal(await ubereats.isLoggedIn({ page: page('https://auth.uber.com/v2/?next_url=...') }), false);
  });
  test('grubhub', async () => {
    assert.equal(await grubhub.isLoggedIn({ page: page('https://restaurant.grubhub.com/financials/transactions') }), true);
    assert.equal(await grubhub.isLoggedIn({ page: page('https://restaurant.grubhub.com/login') }), false);
  });
});

test('ENDPOINTS / SELECTORS configs exist and are labelled', () => {
  for (const m of [dd, ue, gh]) {
    assert.ok(m.ENDPOINTS && m.SELECTORS);
    for (const [k, v] of Object.entries(m.ENDPOINTS)) if (typeof v === 'object') assert.match(v.url, /^https:\/\//, k);
  }
  for (const f of ['doordash.mjs', 'ubereats.mjs', 'grubhub.mjs']) {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), f), 'utf8');
    assert.ok(src.includes(`// UNVERIFIED until confirmed with: npm run ops:record ${f.replace('.mjs', '')}`), f);
  }
});
