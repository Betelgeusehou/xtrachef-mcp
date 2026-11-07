// node --test ops/vendors/labor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import homebase, { apiCollect, parseLinkHeader, mapApiTimecard, mapApiShift, SELECTORS as HB_SEL, ENDPOINTS as HB_EP } from './homebase.mjs';
import toastPayroll, { classifyMoney, mapApiPayroll, ENDPOINTS as TP_EP } from './toast-payroll.mjs';
import {
  businessDate, readXlsx, readZip, readTable, hours, num, mapHeaders, workweekStart, computeWeeklyOvertime, combineDateTime, isoInZone, zonedToUtc,
} from './_labor-common.mjs';
import { KINDS } from '../core/store.mjs';

const fx = f => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'labor', f);
const read = f => fs.readFileSync(fx(f));
const close = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

const KEYS_OK = (kind, recs) => {
  for (const r of recs) {
    for (const k of KINDS[kind].key) assert.ok(r[k] !== undefined && r[k] !== null && r[k] !== '', `${kind} missing ${k}`);
    for (const k of Object.keys(r)) assert.ok(KINDS[kind].cols.includes(k) || k === 'extra', `${kind} unexpected field ${k}`);
  }
};

// ---------------------------------------------------------------- common

test('number and hours parsing', () => {
  assert.equal(num('$1,234.50'), 1234.5);
  assert.equal(num('(12.00)'), -12);
  assert.equal(num(''), null);
  assert.equal(hours('7:30'), 7.5);
  assert.equal(hours('7h 30m'), 7.5);
  assert.equal(hours('8.25'), 8.25);
});

test('business date: before 4 AM local belongs to the previous date (DST-aware)', () => {
  assert.equal(businessDate('2026-10-25T05:30:00Z'), '2026-10-24');      // 12:30 AM CDT
  assert.equal(businessDate('2026-10-25T08:59:00Z'), '2026-10-24');      // 3:59 AM CDT
  assert.equal(businessDate('2026-10-25T09:00:00Z'), '2026-10-25');      // 4:00 AM CDT
});

test('business date in CST after the November DST change', () => {
  // 09:30Z on Nov 8 2026 is 3:30 AM CST -> previous business date.
  assert.equal(businessDate('2026-11-08T09:30:00Z'), '2026-11-07');
  assert.equal(isoInZone(zonedToUtc('2026-11-08', 21, 0)), '2026-11-08T21:00:00-06:00');
  assert.equal(isoInZone(zonedToUtc('2026-07-04', 21, 0)), '2026-07-04T21:00:00-05:00');
});

test('overnight clock-out rolls to the next day', () => {
  const inMs = combineDateTime('2026-10-23', '6:00 PM');
  const outMs = combineDateTime('2026-10-23', '2:30 AM', { after: inMs });
  assert.equal((outMs - inMs) / 3600000, 8.5);
});

test('header aliasing is case/punctuation-insensitive', () => {
  const cols = mapHeaders(['CLOCK-IN', 'clock out', 'Wage  Rate', 'Employee Name'], {
    clock_in: ['Clock In'], clock_out: ['Clock Out'], wage: ['Wage Rate'], employee: ['Employee', 'Employee Name'],
  });
  assert.deepEqual(cols, { clock_in: 0, clock_out: 1, wage: 2, employee: 3 });
});

test('workweek start is configurable (default Monday)', () => {
  assert.equal(workweekStart('2026-10-25'), '2026-10-19');         // Sunday -> Monday before
  assert.equal(workweekStart('2026-10-25', 0), '2026-10-25');      // Sunday-start week
  assert.equal(workweekStart('2026-10-19', 0), '2026-10-18');
});

test('weekly OT splits chronologically and skips salaried', () => {
  const mk = (d, h, extra = {}) => ({ employee: 'X', business_date: d, clock_in: `${d}T16:00:00-05:00`, wage_rate: 10, extra: { paid_hours: h, ...extra } });
  const s = [mk('2026-10-19', 12), mk('2026-10-20', 12), mk('2026-10-21', 12), mk('2026-10-22', 12), mk('2026-10-26', 5), { ...mk('2026-10-19', 60, { salaried: true }), employee: 'M' }];
  computeWeeklyOvertime(s);
  assert.deepEqual(s.slice(0, 4).map(x => [x.regular_hours, x.ot_hours]), [[12, 0], [12, 0], [12, 0], [4, 8]]);
  assert.equal(s[3].labor_cost, 40 + 8 * 15);
  assert.equal(s[4].ot_hours, 0); // new week
  assert.equal(s[5].ot_hours, undefined);
});

// ---------------------------------------------------------------- xlsx reader

function buildZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text, method] of entries) {
    const raw = Buffer.from(text, 'utf8');
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameB = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nameB, data); centrals.push(ch, nameB);
    off += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('xlsx reader: in-test workbook (shared strings, inline strings, gaps, stored + deflate)', () => {
  const buf = buildZip([
    ['xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Register" sheetId="1" r:id="rId1"/></sheets></workbook>', 8],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>', 0],
    ['xl/sharedStrings.xml', '<sst><si><t>Employee</t></si><si><t>Gross Pay</t></si><si><r><t>Lee, </t></r><r><t>Sam &amp; Co</t></r></si></sst>', 8],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="inlineStr"><is><t>x</t></is></c><c r="C3"><v>450.5</v></c></row></sheetData></worksheet>', 8],
  ]);
  assert.equal(readZip(buf).size, 4);
  const x = readXlsx(buf);
  assert.equal(x.sheet, 'Register');
  assert.deepEqual(x.rows, [['Employee', '', 'Gross Pay'], ['Lee, Sam & Co', 'x', 450.5]]);
});

test('xlsx reader: openpyxl-generated fixture (dates as serials)', () => {
  const rows = readTable(read('toast-payroll-employee-detail-washington-2026-10-30.xlsx'), { filename: 'x.xlsx' });
  assert.equal(rows[0][0], 'Employee Detail Report');
  assert.equal(rows[2][0], 'Employee Name');
  assert.equal(rows[3][0], 'Patel, Dev');
  assert.equal(typeof rows[3][3], 'number'); // check date serial
});

// ---------------------------------------------------------------- homebase files

test('homebase timesheets CSV: store mapping, business date, OT computed, salaried row, totals skipped', () => {
  const { labor_shifts: s, schedule_shifts } = homebase.parseFile(read('homebase-timesheets-2026-10-19.csv'), { filename: 'homebase-timesheets-2026-10-19.csv' });
  KEYS_OK('labor_shifts', s);
  assert.equal(s.length, 10);
  assert.equal(schedule_shifts.length, 0);
  assert.deepEqual([...new Set(s.map(r => r.store))].sort(), ['Montrose', 'Washington']);
  const ana = s.filter(r => r.employee === 'Ana Ruiz');
  close(ana.reduce((a, r) => a + r.ot_hours, 0), 8.5);                 // 48.5 h week
  close(ana.reduce((a, r) => a + r.regular_hours, 0), 40);
  assert.ok(ana.every(r => r.extra.ot_computed === true));
  const fri = ana.find(r => r.business_date === '2026-10-23');
  assert.equal(fri.regular_hours, 8); assert.equal(fri.ot_hours, 0.5); assert.equal(fri.labor_cost, 87.5);
  assert.equal(fri.clock_out, '2026-10-24T02:30:00-05:00');
  assert.equal(fri.tips_declared, 330);
  const sat = ana.find(r => r.business_date === '2026-10-24');
  assert.equal(sat.ot_hours, 8); assert.equal(sat.labor_cost, 120);  // 30 min break excluded via Total Paid Hours
  const late = s.find(r => r.employee === 'Dev Patel' && r.clock_in.startsWith('2026-10-25T00:30'));
  assert.equal(late.business_date, '2026-10-24');                      // 12:30 AM clock-in
  assert.equal(late.store, 'Washington');
  const mgr = s.find(r => r.employee === 'Riley Chen');
  assert.equal(mgr.extra.salaried, true);
  assert.equal(mgr.wage_rate, null); assert.equal(mgr.labor_cost, null);
  assert.equal(mgr.extra.annual_salary, 60000);
  assert.equal(mgr.ot_hours, 0); assert.equal(mgr.extra.ot_exempt, true);
  close(s.filter(r => !r.extra.salaried).reduce((a, r) => a + r.labor_cost, 0), 80 * 4 + 87.5 + 120 + 112.5 + 72 + 30);
});

test('homebase timesheets with an OT split in the file: used as-is, not recomputed', () => {
  const csv = 'Employee,Location,Date,Clock In,Clock Out,Regular Hours,Overtime Hours,Wage Rate,Total Pay,Tips\n' +
    'Ana Ruiz,Betelgeuse Betelgeuse - Montrose,10/23/2026,6:00 PM,2:30 AM,6.00,2.50,10.00,97.50,5\n';
  const [r] = homebase.parseFile(Buffer.from(csv), { filename: 'Homebase timesheets.csv' }).labor_shifts;
  assert.equal(r.regular_hours, 6); assert.equal(r.ot_hours, 2.5); assert.equal(r.labor_cost, 97.5);
  assert.equal(r.extra.ot_computed, false); assert.equal(r.tips_declared, 5);
});

test('homebase schedule CSV: "Last, First" names, overnight end, open shift skipped, store mapping', () => {
  const res = homebase.parseFile(read('homebase-schedule-2026-10-19.csv'), { filename: 'homebase-schedule-2026-10-19.csv' });
  const s = res.schedule_shifts;
  KEYS_OK('schedule_shifts', s);
  assert.equal(s.length, 3);
  assert.equal(res.stats.open_shifts_skipped, 1);
  assert.deepEqual(Object.keys(res), ['labor_shifts', 'schedule_shifts'], 'stats not enumerable');
  const sat = s.find(r => r.employee === 'Dev Patel' && r.business_date === '2026-10-24');
  assert.equal(sat.end, '2026-10-25T02:00:00-05:00'); assert.equal(sat.scheduled_hours, 8); assert.equal(sat.scheduled_cost, 96);
  assert.equal(sat.shift_id, 'Washington|dev patel|2026-10-24T23:00Z|barback');
  assert.equal(s.find(r => r.employee === 'Ana Ruiz').store, 'Montrose');
  assert.ok(!s.some(r => r.employee === 'OPEN'));
  close(s.reduce((a, r) => a + r.scheduled_hours, 0), 22);
});

test('homebase schedule grid layout (one column per day)', () => {
  const csv = 'Betelgeuse Betelgeuse - Montrose,,,\nEmployee,"Mon 10/19/2026","Tue 10/20/2026","Fri 10/23/2026"\nAna Ruiz,4pm-12am Bartender,,6pm-2am Bartender\n';
  const { schedule_shifts: s } = homebase.parseFile(Buffer.from(csv), { filename: 'homebase-schedule.csv' });
  assert.equal(s.length, 2);
  assert.equal(s[1].end, '2026-10-24T02:00:00-05:00');
  assert.equal(s[1].role, 'Bartender'); assert.equal(s[0].store, 'Montrose');
});

test('homebase matchFile', () => {
  assert.equal(homebase.matchFile({ from: 'reports@joinhomebase.com', filename: 'timesheets.csv' }), true);
  assert.equal(homebase.matchFile({ from: 'chris@betelgeusehou.com', filename: 'Homebase Timesheets Oct.csv' }), true);
  assert.equal(homebase.matchFile({ from: 'x@y.com', filename: 'timesheets.csv' }), false);
  assert.equal(homebase.matchFile({ from: 'reports@joinhomebase.com', filename: 'logo.png' }), false);
});

// ---------------------------------------------------------------- homebase api

const LOCS = [
  { uuid: 'u-mon', name: 'Betelgeuse Betelgeuse - Montrose', time_zone: 'America/Chicago' },
  { uuid: 'u-wash', name: 'Betelgeuse Betelgeuse - Washington', time_zone: 'America/Chicago' },
  { uuid: 'u-x', name: 'Commissary', time_zone: 'America/Chicago' },
];
const tc = (id, first, inIso, outIso, labor = {}) => ({ id, user_id: id * 10, first_name: first, last_name: 'Test', role: 'Bartender', clock_in: inIso, clock_out: outIso, approved: true,
  labor: { wage_type: 'hourly', regular_hours: 8, weekly_overtime: 0, daily_overtime: 0, paid_hours: 8, costs: 80, wage_rate: 10, cash_tips: 5, credit_tips: 20, ...labor } });

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const h = routes[u.pathname];
    if (!h) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
    const { body, headers = {}, status = 200 } = h(u, calls.length);
    return { ok: status < 400, status, headers: new Headers(headers), json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('parseLinkHeader (RFC-5988, as in the Homebase docs)', () => {
  const l = parseLinkHeader('<https://api.joinhomebase.com/locations/x/employees?page=2&per_page=1>; rel="last", <https://api.joinhomebase.com/locations/x/employees?page=2&per_page=1>; rel="next"');
  assert.equal(l.next, 'https://api.joinhomebase.com/locations/x/employees?page=2&per_page=1');
});

test('apiCollect: auth headers, pagination via Link, store mapping, business-date window', async () => {
  const base = 'https://app.joinhomebase.com/api/public';
  let rateLimited = false;
  const fetchImpl = fakeFetch({
    '/api/public/locations': () => ({ body: LOCS }),
    '/api/public/locations/u-mon/timecards': u => u.searchParams.get('page') === '1'
      ? { body: [tc(1, 'Ana', '2026-10-23T23:00:00Z', '2026-10-24T07:30:00Z', { regular_hours: 7.5, weekly_overtime: 1, paid_hours: 8.5, costs: 97.5 })], headers: { Link: `<${base}/locations/u-mon/timecards?page=2&per_page=100>; rel="next"`, Total: '2', 'Per-Page': '1' } }
      : { body: [tc(2, 'Sam', '2026-10-25T05:30:00Z', '2026-10-25T08:00:00Z')], headers: { Total: '2', 'Per-Page': '1' } },
    '/api/public/locations/u-mon/shifts': () => ({ body: [{ id: 9, first_name: 'Ana', last_name: 'Test', role: 'Bartender', start_at: '2026-10-23T23:00:00Z', end_at: '2026-10-24T07:00:00Z', wage_rate: 10, labor: { scheduled_hours: 8, scheduled_costs: 80 } }] }),
    '/api/public/locations/u-wash/timecards': (u, n) => {
      if (!rateLimited) { rateLimited = true; return { status: 429, body: { error: 'Rate limit exceeded' } }; }
      // Total/Per-Page pagination without a Link header
      return u.searchParams.get('page') === '1'
        ? { body: [tc(3, 'Dev', '2026-10-22T22:00:00Z', '2026-10-23T04:00:00Z')], headers: { Total: '2', 'Per-Page': '1' } }
        : { body: [tc(4, 'Out', '2026-10-30T22:00:00Z', '2026-10-31T04:00:00Z')], headers: { Total: '2', 'Per-Page': '1' } };
    },
    '/api/public/locations/u-wash/shifts': () => ({ body: [] }),
  });
  const logs = [];
  const r = await apiCollect({ apiKey: 'k_test' }, { from: '2026-10-19', through: '2026-10-25' }, { fetchImpl, sleep: async () => {}, log: m => logs.push(m) });
  KEYS_OK('labor_shifts', r.labor_shifts); KEYS_OK('schedule_shifts', r.schedule_shifts);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer k_test');
  assert.equal(fetchImpl.calls[0].init.headers.Accept, 'application/vnd.homebase-v1+json');
  const tcCall = new URL(fetchImpl.calls.find(c => c.url.includes('u-mon/timecards')).url);
  assert.equal(tcCall.searchParams.get('date_filter'), 'clock_in');
  assert.equal(tcCall.searchParams.get('start_date'), '2026-10-19T04:00:00-05:00');
  assert.equal(tcCall.searchParams.get('end_date'), '2026-10-26T03:59:59-05:00');
  assert.ok(!fetchImpl.calls.some(c => c.url.includes('u-x')), 'unmapped location skipped');
  assert.ok(logs.some(m => /Commissary/.test(m)) && logs.some(m => /rate limited/.test(m)));
  assert.deepEqual(r.labor_shifts.map(s => s.employee).sort(), ['Ana Test', 'Dev Test', 'Sam Test']); // tc 4 out of range
  const ana = r.labor_shifts.find(s => s.employee === 'Ana Test');
  assert.equal(ana.store, 'Montrose'); assert.equal(ana.business_date, '2026-10-23');
  assert.equal(ana.regular_hours, 7.5); assert.equal(ana.ot_hours, 1); assert.equal(ana.labor_cost, 97.5); assert.equal(ana.tips_declared, 25);
  assert.equal(ana.clock_in, '2026-10-23T18:00:00-05:00');
  assert.equal(r.labor_shifts.find(s => s.employee === 'Sam Test').business_date, '2026-10-24'); // 12:30 AM
  assert.equal(r.labor_shifts.find(s => s.employee === 'Dev Test').store, 'Washington');
  assert.equal(r.schedule_shifts[0].shift_id, 'Montrose|ana test|2026-10-23T23:00Z|bartender'); assert.equal(r.schedule_shifts[0].scheduled_cost, 80);
  assert.equal(r.schedule_shifts[0].extra.homebase_shift_id, 9);
  assert.equal(ana.shift_id, 'Montrose|ana test|2026-10-23T23:00Z'); assert.equal(ana.extra.homebase_timecard_id, 1);
});

test('apiCollect throws on non-2xx (no silent empty result)', async () => {
  const fetchImpl = fakeFetch({ '/api/public/locations': () => ({ status: 401, body: { error: 'unauthorized' } }) });
  await assert.rejects(apiCollect({ apiKey: 'bad' }, { from: '2026-10-19', through: '2026-10-19' }, { fetchImpl, sleep: async () => {} }), /401/);
});

test('collect() uses apiCollect when ctx.creds.apiKey is set', async () => {
  const fetchImpl = fakeFetch({ '/api/public/locations': () => ({ body: [] }) });
  const r = await homebase.collect({ creds: { apiKey: 'k' }, fetch: fetchImpl, api: () => { throw Error('should not call session api'); } }, { from: '2026-10-19', through: '2026-10-19' });
  assert.deepEqual(r, { labor_shifts: [], schedule_shifts: [] });
  assert.equal(fetchImpl.calls.length, 1);
});

test('collect() session mode maps internal JSON from ctx.api', async () => {
  const seen = [];
  const ctx = {
    creds: {}, log: () => {},
    api: async url => {
      seen.push(url);
      if (url.endsWith(HB_EP.locations)) return { data: [{ uuid: 'u-mon', name: 'Betelgeuse Betelgeuse - Montrose' }, { id: 'u-w', name: 'Betelgeuse Betelgeuse - Washington' }] };
      if (url.includes('/timecards')) return url.includes('u-mon') && url.includes('page=1&')
        ? { timecards: [{ id: 11, firstName: 'Ana', lastName: 'Ruiz', role: 'Bartender', clockIn: '2026-10-23T23:00:00Z', clockOut: '2026-10-24T07:00:00Z', labor: { regularHours: 8, costs: 80, wageRate: 10, paidHours: 8, cashTips: 12 } }], meta: { next_page: null } }
        : { timecards: [], meta: { next_page: null } };
      if (url.includes('/shifts')) return url.includes('u-w') ? { shifts: [{ id: 5, first_name: 'Dev', last_name: 'Patel', start_at: '2026-10-24T23:00:00Z', end_at: '2026-10-25T07:00:00Z', scheduled_hours: 8, scheduled_cost: 96 }] } : { shifts: [] };
      throw Error('unexpected ' + url);
    },
  };
  const r = await homebase.collect(ctx, { from: '2026-10-19', through: '2026-10-25' });
  assert.equal(r.labor_shifts.length, 1);
  const a = r.labor_shifts[0];
  assert.deepEqual([a.store, a.employee, a.business_date, a.regular_hours, a.labor_cost, a.tips_declared, a.extra.source], ['Montrose', 'Ana Ruiz', '2026-10-23', 8, 80, 12, 'session']);
  assert.deepEqual([r.schedule_shifts[0].store, r.schedule_shifts[0].scheduled_cost, r.schedule_shifts[0].business_date], ['Washington', 96, '2026-10-24']);
  assert.ok(seen.every(u => u.startsWith('https://app.joinhomebase.com/')));
});

test('mapApiTimecard: salaried flag and open timecard', () => {
  const r = mapApiTimecard({ id: 7, first_name: 'Riley', last_name: 'Chen', clock_in: '2026-10-20T15:00:00Z', clock_out: null, labor: { wage_type: 'salary', regular_hours: 0, costs: 0 } }, LOCS[1]);
  assert.equal(r.extra.salaried, true); assert.equal(r.clock_out, null); assert.equal(r.extra.open, true); assert.equal(r.store, 'Washington');
});

// ---------------------------------------------------------------- homebase login

function fakePage({ codeScreen = false, emailFirst = false, failLogin = false } = {}) {
  const state = { url: 'about:blank', filled: {}, clicks: [], step: 'email' };
  return {
    state,
    url: () => state.url,
    async goto(u) { state.url = u; },
    async fill(sel, v) { state.filled[sel] = v; },
    async click(sel) {
      state.clicks.push(sel);
      if (sel === HB_SEL.continue) state.step = 'password';
      if (sel === HB_SEL.submit) {
        if (failLogin) return;
        if (codeScreen) { state.step = 'code'; state.url = 'https://app.joinhomebase.com/accounts/verify'; }
        else { state.step = 'in'; state.url = 'https://app.joinhomebase.com/schedule'; }
      }
      if (sel === HB_SEL.codeSubmit && state.step === 'code') { state.step = 'in'; state.url = 'https://app.joinhomebase.com/schedule'; }
    },
    async waitForLoadState() {},
    async waitForSelector(sel) {
      const ok = (sel === HB_SEL.password && (!emailFirst || state.step === 'password')) || (sel === HB_SEL.continue && emailFirst)
        || (sel === HB_SEL.code && state.step === 'code') || (sel === HB_SEL.signedInMarker && state.step === 'in');
      if (!ok) throw Error('timeout');
    },
  };
}

test('login: email + password, emailed verification code', async () => {
  const page = fakePage({ codeScreen: true });
  const asked = [];
  const ctx = { page, creds: { username: 'ops@example.com', password: 'pw' }, log: () => {}, waitForEmailCode: async o => { asked.push(o); return '482913'; } };
  assert.equal(await homebase.login(ctx), true);
  assert.equal(page.state.filled[HB_SEL.email], 'ops@example.com');
  assert.equal(page.state.filled[HB_SEL.code], '482913');
  assert.equal(asked[0].from, 'joinhomebase.com');
  assert.equal(await homebase.isLoggedIn(ctx), true);
});

test('login: email-first variant without a code screen', async () => {
  const page = fakePage({ emailFirst: true });
  const ctx = { page, creds: { username: 'a', password: 'b' }, log: () => {}, waitForEmailCode: async () => { throw Error('not expected'); } };
  assert.equal(await homebase.login(ctx), true);
  assert.ok(page.state.clicks.includes(HB_SEL.continue));
});

test('login: fails loudly when still on sign-in; isLoggedIn false on sign-in page', async () => {
  const page = fakePage({ failLogin: true });
  const ctx = { page, creds: { username: 'a', password: 'b' }, log: () => {}, waitForEmailCode: async () => null };
  await assert.rejects(homebase.login(ctx), /still on the sign-in page/);
  assert.equal(await homebase.isLoggedIn(ctx), false);
});

// ---------------------------------------------------------------- toast payroll files

test('money column classification: employee vs employer taxes', () => {
  const t = h => classifyMoney(h);
  assert.equal(t('Social Security - ER'), 'er_tax');
  assert.equal(t('Medicare - EE'), 'ee_tax');
  assert.equal(t('Federal Income Tax'), 'ee_tax');
  assert.equal(t('FUTA'), 'er_tax');
  assert.equal(t('TX SUI'), 'er_tax');
  assert.equal(t('Employer Taxes'), 'er_tax_total');
  assert.equal(t('Employee Taxes'), 'ee_tax_total');
  assert.equal(t('Health Insurance - ER'), 'er_benefit');
  assert.equal(t('Health Insurance - EE'), 'ee_deduction');
  assert.equal(t('Credit Card Tips'), 'tips');
  assert.equal(t('Gross Pay'), 'gross');
  assert.equal(t('Regular Hours'), null);
  assert.equal(t('Check Date'), null);
});

test('toast payroll register CSV -> runs + lines (Montrose)', () => {
  const r = toastPayroll.parseFile(read('toast-payroll-register-montrose-2026-10-30.csv'), { filename: 'toast-payroll-register-montrose-2026-10-30.csv' });
  KEYS_OK('payroll_runs', r.payroll_runs); KEYS_OK('payroll_lines', r.payroll_lines);
  assert.equal(r.payroll_lines.length, 3);
  const [run] = r.payroll_runs;
  assert.deepEqual([run.store, run.pay_date, run.period_start, run.period_end, run.employee_count], ['Montrose', '2026-10-30', '2026-10-12', '2026-10-25', 3]);
  close(run.gross_wages, 5085.19);
  close(run.employer_taxes, 315.29 + 73.74 + 8.70 + 75.00);
  close(run.benefits, 300);
  close(run.total_cost, 5085.19 + 472.73 + 300);
  close(run.extra.employee_taxes, 450 + 315.29 + 73.74);
  close(run.extra.salaried_gross, 2307.69);
  close(run.extra.tips, 1400);
  close(run.extra.wages_ex_tips, 5085.19 - 1400);
  assert.equal(run.run_id, 'Montrose|2026-10-30|2026-10-12|2026-10-25');
  assert.ok(r.payroll_lines.every(l => l.run_id === run.run_id));
  const ana = r.payroll_lines.find(l => l.employee === 'Ana Ruiz #1001');
  assert.equal(ana.extra.employee_name, 'Ana Ruiz'); assert.equal(ana.extra.employee_id, '1001');
  assert.deepEqual([ana.regular_hours, ana.ot_hours, ana.tips, ana.employer_taxes], [80, 8.5, 1400, 246.91]);
  close(ana.extra.employee_taxes, 358.06); close(ana.extra.gross_ex_tips, 927.5);
  const mgr = r.payroll_lines.find(l => l.employee === 'Riley Chen #1003');
  assert.equal(mgr.extra.salaried, true); assert.equal(mgr.regular_hours, null);
  assert.equal(mgr.extra.employer_benefits, 300); assert.equal(mgr.extra.employee_deductions, 75);
});

test('toast payroll employee detail XLSX -> runs + lines (Washington)', () => {
  const r = toastPayroll.parseFile(read('toast-payroll-employee-detail-washington-2026-10-30.xlsx'), { filename: 'toast-payroll-employee-detail-washington-2026-10-30.xlsx' });
  KEYS_OK('payroll_runs', r.payroll_runs); KEYS_OK('payroll_lines', r.payroll_lines);
  assert.equal(r.payroll_lines.length, 2);
  const [run] = r.payroll_runs;
  assert.deepEqual([run.store, run.pay_date, run.period_start, run.period_end], ['Washington', '2026-10-30', '2026-10-12', '2026-10-25']);
  close(run.gross_wages, 2289); close(run.employer_taxes, 191.52); close(run.benefits, 250); close(run.total_cost, 2730.52);
  assert.equal(run.run_id, 'Washington|2026-10-30|2026-10-12|2026-10-25');
  close(run.extra.wages_ex_tips, run.gross_wages - run.extra.tips);
  assert.ok(r.payroll_lines.some(l => l.employee.includes('&')), 'XML entities decoded');
});

test('toast payroll matchFile', () => {
  assert.equal(toastPayroll.matchFile({ from: 'noreply@toasttab.com', filename: 'Payroll Register 10-30.xlsx' }), true);
  assert.equal(toastPayroll.matchFile({ from: 'chris@betelgeusehou.com', filename: 'Toast payroll register.csv' }), true);
  assert.equal(toastPayroll.matchFile({ from: 'noreply@toasttab.com', filename: 'Sales Summary.csv' }), false);
  assert.equal(toastPayroll.matchFile({ from: 'noreply@toasttab.com', filename: 'Payroll Register.pdf' }), false);
});

test('toast payroll session collect maps internal JSON from ctx.api', async () => {
  const ctx = {
    log: () => {},
    api: async url => {
      if (url.includes('/payrolls?')) return { payrolls: [
        { id: 'p1', checkDate: '2026-10-30', periodStart: '2026-10-12', periodEnd: '2026-10-25', locationName: 'Betelgeuse Betelgeuse - Montrose' },
        { id: 'p0', checkDate: '2026-09-30', locationName: 'Betelgeuse Betelgeuse - Montrose' },
      ] };
      if (url.includes('/p1/')) return { employees: [
        { employeeName: 'Ana Ruiz', grossPay: 1000, tips: 200, earnings: [{ name: 'Regular', hours: 40, amount: 400 }, { name: 'Overtime', hours: 4, amount: 60 }],
          taxes: [{ name: 'SS', paidBy: 'Employee', amount: 62 }, { name: 'SS', paidBy: 'Employer', amount: 62 }, { name: 'FUTA', paidBy: 'Employer', amount: 6 }] },
        { employeeName: 'Riley Chen', payType: 'Salary', grossPay: 2307.69, employerTaxes: 176.54, employeeTaxes: 426.54, employerBenefits: 300 },
      ] };
      throw Error('unexpected ' + url);
    },
  };
  const r = await toastPayroll.collect(ctx, { from: '2026-10-01', through: '2026-10-31' });
  KEYS_OK('payroll_runs', r.payroll_runs); KEYS_OK('payroll_lines', r.payroll_lines);
  assert.equal(r.payroll_runs.length, 1);
  const ana = r.payroll_lines.find(l => l.employee === 'Ana Ruiz');
  assert.deepEqual([ana.store, ana.regular_hours, ana.ot_hours, ana.employer_taxes, ana.extra.employee_taxes, ana.tips], ['Montrose', 40, 4, 68, 62, 200]);
  close(r.payroll_runs[0].total_cost, 1000 + 2307.69 + 68 + 176.54 + 300);
  assert.equal(r.payroll_runs[0].run_id, 'Montrose|2026-10-30|2026-10-12|2026-10-25');
  assert.equal(r.payroll_runs[0].extra.toast_run_id, 'p1'); assert.equal(ana.extra.toast_run_id, 'p1');
  close(r.payroll_runs[0].extra.tips, 200); close(r.payroll_runs[0].extra.wages_ex_tips, 3307.69 - 200);
  close(ana.extra.gross_ex_tips, 800);
  assert.ok(TP_EP.pastPayrolls('a', 'b').startsWith('/'));
});

test('toast payroll session collect rethrows when JSON fails and there is no page for the UI fallback', async () => {
  await assert.rejects(toastPayroll.collect({ log: () => {}, api: async () => { const e = Error('404'); e.status = 404; throw e; } }, { from: '2026-10-01', through: '2026-10-31' }), /404/);
});

// ---------------------------------------------------------------- review fixes

test('toast payroll: session JSON and the file of the same payroll produce identical keys (no double count)', async () => {
  const file = toastPayroll.parseFile(read('toast-payroll-register-montrose-2026-10-30.csv'), { filename: 'toast-payroll-register-montrose-2026-10-30.csv' });
  const run = { id: 'tp-8812', checkDate: '2026-10-30', periodStart: '2026-10-12', periodEnd: '2026-10-25', locationName: 'Betelgeuse Betelgeuse - Montrose' };
  const details = { employees: [
    { employeeName: 'Ruiz, Ana', employeeNumber: '1001', grossPay: 2327.5, tips: 1400 },
    { employeeName: 'Lee, Sam', employeeNumber: '1002', grossPay: 450 },
    { employeeName: 'Chen, Riley', employeeNumber: '1003', payType: 'Salary', grossPay: 2307.69 },
  ] };
  const ctx = { log: () => {}, api: async url => (url.includes('/payrolls?') ? { payrolls: [run] } : details) };
  const sess = await toastPayroll.collect(ctx, { from: '2026-10-01', through: '2026-10-31' });
  const runKeys = rs => rs.map(r => `${r.vendor}|${r.run_id}`).sort();
  const lineKeys = ls => ls.map(l => `${l.vendor}|${l.run_id}|${l.employee}`).sort();
  assert.deepEqual(runKeys(sess.payroll_runs), runKeys(file.payroll_runs));
  assert.deepEqual(lineKeys(sess.payroll_lines), lineKeys(file.payroll_lines));
  assert.equal(sess.payroll_runs[0].extra.toast_run_id, 'tp-8812');
  // Upserting both into the store leaves one run and three lines.
  const store = await import('../core/store.mjs');
  store.close(); store.open(':memory:');
  try {
    store.upsertResult(file, { mode: 'inbox' });
    store.upsertResult(sess, { mode: 'session' });
    assert.equal(store.query('payroll_runs').length, 1);
    assert.equal(store.query('payroll_lines').length, 3);
  } finally { store.close(); }
});

test('toast payroll: same-name employees with different ids stay separate; no id -> name only', () => {
  const head = 'Location: Betelgeuse Betelgeuse - Montrose\nCheck Date: 10/30/2026\nPay Period: 10/12/2026 - 10/25/2026\n';
  const csv = head + 'Employee,Employee ID,Regular Hours,Gross Pay,Cash Tips\n"Lee, Sam",1002,10,100,10\n"Lee, Sam",1077,20,200,0\n';
  const r = toastPayroll.parseFile(Buffer.from(csv), { filename: 'toast payroll register montrose.csv' });
  assert.deepEqual(r.payroll_lines.map(l => l.employee).sort(), ['Sam Lee #1002', 'Sam Lee #1077']);
  assert.equal(r.payroll_runs[0].employee_count, 2);
  close(r.payroll_runs[0].extra.wages_ex_tips, 290); close(r.payroll_runs[0].extra.tips, 10);
  const noIdCsv = head + 'Employee,Regular Hours,Gross Pay,Cash Tips\n"Lee, Sam",10,100,10\n';
  const noId = toastPayroll.parseFile(Buffer.from(noIdCsv), { filename: 'toast payroll register montrose.csv' });
  assert.equal(noId.payroll_lines[0].employee, 'Sam Lee');
  const api = mapApiPayroll({ id: 'x', checkDate: '2026-10-30', periodStart: '2026-10-12', periodEnd: '2026-10-25', locationName: 'Montrose' },
    { employees: [{ employeeName: 'Sam Lee', grossPay: 1 }, { employeeName: 'Sam Lee', employeeId: 'e9', grossPay: 2 }] });
  assert.deepEqual(api.map(l => l.employee), ['Sam Lee', 'Sam Lee #e9']);
});

test('homebase: API timecard and Timesheets CSV row for the same shift share a shift_id', () => {
  const csv = 'First Name,Last Name,Payroll ID,Role,Location,Date,Clock In,Clock Out,Total Paid Hours,Wage Rate\n' +
    'Ana,Ruiz,1001,Bartender,Betelgeuse Betelgeuse - Montrose,10/23/2026,6:00 PM,2:30 AM,8.50,$10.00\n';
  const [fileRec] = homebase.parseFile(Buffer.from(csv), { filename: 'homebase-timesheets.csv' }).labor_shifts;
  const apiRec = mapApiTimecard({ id: 555, payroll_id: '1001', first_name: 'Ana', last_name: 'Ruiz', role: 'Bartender', clock_in: '2026-10-23T23:00:42Z', clock_out: '2026-10-24T07:30:00Z', labor: { regular_hours: 8.5, paid_hours: 8.5, costs: 85, wage_rate: 10 } }, LOCS[0]);
  assert.equal(fileRec.shift_id, 'Montrose|id:1001|2026-10-23T23:00Z');
  assert.equal(apiRec.shift_id, fileRec.shift_id);
  assert.equal(apiRec.extra.homebase_timecard_id, 555);
  // Without a payroll id both fall back to the normalized name.
  const noId = mapApiTimecard({ id: 556, first_name: ' Ana ', last_name: 'RUIZ', clock_in: '2026-10-23T23:00:00Z', labor: {} }, LOCS[0]);
  assert.equal(noId.shift_id, 'Montrose|ana ruiz|2026-10-23T23:00Z');
});

test('homebase: API shift and Schedule CSV row for the same shift share a shift_id; API open shifts skipped', async () => {
  const sched = 'Employee,Role,Location,Date,Start,End,Scheduled Hours\n"Ruiz, Ana",Bartender,Betelgeuse Betelgeuse - Montrose,10/23/2026,6:00 PM,2:00 AM,8\n';
  const [fileRec] = homebase.parseFile(Buffer.from(sched), { filename: 'homebase-schedule.csv' }).schedule_shifts;
  const apiRec = mapApiShift({ id: 9, first_name: 'Ana', last_name: 'Ruiz', role: 'Bartender', start_at: '2026-10-23T23:00:00Z', end_at: '2026-10-24T07:00:00Z', labor: { scheduled_hours: 8 } }, LOCS[0]);
  assert.equal(apiRec.shift_id, fileRec.shift_id);
  assert.equal(fileRec.shift_id, 'Montrose|ana ruiz|2026-10-23T23:00Z|bartender');
  const fetchImpl = fakeFetch({
    '/api/public/locations': () => ({ body: [LOCS[0]] }),
    '/api/public/locations/u-mon/timecards': () => ({ body: [] }),
    '/api/public/locations/u-mon/shifts': () => ({ body: [
      { id: 1, first_name: 'Ana', last_name: 'Ruiz', role: 'Bartender', start_at: '2026-10-23T23:00:00Z', end_at: '2026-10-24T07:00:00Z', labor: { scheduled_hours: 8 } },
      { id: 2, open: true, role: 'Bartender', start_at: '2026-10-24T01:00:00Z', end_at: '2026-10-24T07:00:00Z', labor: { scheduled_hours: 6 } },
    ] }),
  });
  const r = await apiCollect({ apiKey: 'k' }, { from: '2026-10-19', through: '2026-10-25' }, { fetchImpl, sleep: async () => {} });
  assert.equal(r.schedule_shifts.length, 1);
  assert.equal(r.stats.open_shifts_skipped, 1);
});

test('homebase CSV: computed OT flags rows in workweeks the file does not fully cover', () => {
  // File covers Wed 10/21 .. Mon 10/26: week of 10/19 starts before it, week of 10/26 ends after it.
  const rows = ['10/21/2026', '10/22/2026', '10/25/2026', '10/26/2026'].map(d => `Ana,Ruiz,1001,Betelgeuse Betelgeuse - Montrose,${d},4:00 PM,12:00 AM,8.00,$10.00`);
  const csv = 'First Name,Last Name,Payroll ID,Location,Date,Clock In,Clock Out,Total Paid Hours,Wage Rate\n' + rows.join('\n') + '\n';
  const res = homebase.parseFile(Buffer.from(csv), { filename: 'homebase-timesheets.csv' });
  assert.ok(res.labor_shifts.every(r => r.extra.ot_partial_week === true));
  assert.equal(res.stats.ot_partial_week_rows, 4);
  // The 10/19 fixture covers Mon 10/19 .. Sun 10/25 exactly: not partial.
  const full = homebase.parseFile(read('homebase-timesheets-2026-10-19.csv'), { filename: 'homebase-timesheets-2026-10-19.csv' });
  assert.ok(full.labor_shifts.filter(r => r.extra.ot_computed).every(r => r.extra.ot_partial_week === false));
  // Files with their own OT split are not flagged.
  const own = homebase.parseFile(Buffer.from('Employee,Location,Date,Clock In,Clock Out,Regular Hours,Overtime Hours\nAna Ruiz,Betelgeuse Betelgeuse - Montrose,10/23/2026,6:00 PM,2:30 AM,6,2.5\n'), { filename: 'Homebase timesheets.csv' });
  assert.equal(own.labor_shifts[0].extra.ot_partial_week, undefined);
});

test('xlsx/zip reader rejects oversized entries (zip bomb guard)', () => {
  // Declared size over the 50 MB limit is refused before inflating.
  const big = buildZip([['xl/worksheets/sheet1.xml', '<worksheet/>', 8]]);
  const cdOff = big.readUInt32LE(big.length - 22 + 16);
  const lied = Buffer.from(big); lied.writeUInt32LE(60 * 1024 * 1024, cdOff + 24);
  assert.throws(() => readZip(lied), /declares 62914560 bytes uncompressed/);
  // An entry that inflates past its (small) declared size is refused too.
  const bomb = buildZip([['xl/worksheets/sheet1.xml', 'A'.repeat(200000), 8]]);
  const off2 = bomb.readUInt32LE(bomb.length - 22 + 16);
  const small = Buffer.from(bomb); small.writeUInt32LE(1000, off2 + 24);
  assert.throws(() => readZip(small), /inflates past its declared size 1000/);
  assert.throws(() => readTable(small, { filename: 'x.xlsx' }), /zip:/);
  // Honest entries still read.
  assert.equal(readZip(bomb).get('xl/worksheets/sheet1.xml').length, 200000);
});

test('adapter shapes match the contract', () => {
  for (const [a, id, domain, kinds] of [[homebase, 'homebase', 'labor', ['labor_shifts', 'schedule_shifts']], [toastPayroll, 'toast-payroll', 'payroll', ['payroll_runs', 'payroll_lines']]]) {
    assert.equal(a.id, id); assert.equal(a.domain, domain); assert.deepEqual(a.kinds, kinds);
    for (const f of ['isLoggedIn', 'collect', 'matchFile', 'parseFile']) assert.equal(typeof a[f], 'function');
    assert.ok(Array.isArray(a.handoffDomains) && a.handoffDomains.length);
    assert.ok(a.loginUrl.startsWith('https://'));
  }
  assert.deepEqual(homebase.modes, ['api', 'session', 'login', 'inbox', 'drive']);
  assert.equal(typeof homebase.login, 'function'); assert.equal(typeof homebase.apiCollect, 'function');
  assert.deepEqual(toastPayroll.modes, ['session', 'inbox', 'drive']);
  assert.equal(toastPayroll.login, undefined);
  assert.ok(toastPayroll.handoffDomains.includes('payroll.toasttab.com') && toastPayroll.handoffDomains.includes('toasttab.com'));
});
