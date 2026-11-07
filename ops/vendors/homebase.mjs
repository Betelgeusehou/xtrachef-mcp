// Homebase (scheduling, time clock, manager logs) -> labor_shifts + schedule_shifts.
//
// Modes, in order:
//   api     Homebase Public API (read-only key). VERIFIED against the published Swagger doc:
//           https://app.joinhomebase.com/api/public/swagger_doc.json  (key requested at
//           https://app.joinhomebase.com/settings/api, approved by Homebase). See LABOR.md.
//   session Logged-in web app, internal JSON via ctx.api (endpoints UNVERIFIED).
//   login   Email + password, emailed verification code if Homebase asks (selectors UNVERIFIED).
//   inbox / drive  Timesheets export CSV and Schedule export CSV (column names ASSUMED, aliased).
import { canonicalStore } from '../core/stores.mjs';
import {
  TZ, round2, round4, num, hours, findHeaderRow, isTotalRow, readTable, normHeader,
  businessDate, businessWindow, isoInZone, combineDateTime, parseDate, parseTime, addDays,
  computeWeeklyOvertime, inRange, arrayIn, pick, zonedToUtc, workweekStart,
} from './_labor-common.mjs';

const VENDOR = 'homebase';

// ---------------------------------------------------------------- natural keys
// shift_id is built from business facts, never from a vendor id, so the same shift collected via the
// API, a session, or a CSV export upserts onto one row. Vendor ids stay in extra.
//   labor_shifts:    `${store}|${employeeKey}|${clock_in UTC minute}`
//   schedule_shifts: `${store}|${employeeKey}|${start UTC minute}|${role}`
// For labor_shifts employeeKey prefers the Homebase payroll id (present on API timecards and the
// Timesheets export) and falls back to the normalized full name. schedule_shifts use the name only
// (the API Shift entity has no documented payroll id). See LABOR.md.
export const normName = n => String(n ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function employeeKey(name, payrollId) {
  const id = payrollId === undefined || payrollId === null ? '' : String(payrollId).trim();
  return id ? `id:${id.toLowerCase()}` : normName(name);
}
const minuteUtc = ms => new Date(Math.floor(ms / 60000) * 60000).toISOString().slice(0, 16) + 'Z';
export const laborShiftId = (store, key, clockInMs) => `${store || 'unknown'}|${key}|${minuteUtc(clockInMs)}`;
export const scheduleShiftId = (store, key, startMs, role) => `${store || 'unknown'}|${key}|${minuteUtc(startMs)}|${normName(role)}`;
export const isOpenShift = name => !String(name ?? '').trim() || /^(open|unassigned)( shift)?$/i.test(String(name).trim());

// Results carry a non-enumerable `stats` so ops/core/store.upsertResult only sees record kinds.
function withStats(res, stats) {
  Object.defineProperty(res, 'stats', { value: { open_shifts_skipped: 0, ...stats }, enumerable: false, writable: true });
  return res;
}
// Drops unassigned/OPEN schedule shifts (they would inflate scheduled hours) and counts them.
function dropOpen(schedule, stats) {
  const kept = schedule.filter(s => !s.extra?.open);
  stats.open_shifts_skipped += schedule.length - kept.length;
  return kept;
}

// ---------------------------------------------------------------- public API (verified)

export const API = {
  // Swagger: host app.joinhomebase.com, basePath /api/public. The doc's curl example also uses
  // https://api.joinhomebase.com/locations; override with creds.apiBase if one stops answering.
  base: 'https://app.joinhomebase.com/api/public',
  accept: 'application/vnd.homebase-v1+json',
  perPage: 100,                 // docs example shows "Per-Page: 100"
  rateLimitPerMinute: 60,       // per UUID in the URL; 429 {"error":"Rate limit exceeded"}
  locations: () => '/locations',
  timecards: uuid => `/locations/${encodeURIComponent(uuid)}/timecards`, // start_date, end_date, date_filter=clock_in|clock_out|created_at|updated_at, page, per_page
  shifts: uuid => `/locations/${encodeURIComponent(uuid)}/shifts`,       // start_date, end_date, date_filter=start_at|end_at|created_at|updated_at, open, with_note, page, per_page
};

// RFC-5988 Link header -> {next: url, last: url, ...}
export function parseLinkHeader(h) {
  const out = {};
  for (const part of String(h || '').split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    if (m) out[m[2]] = m[1];
  }
  return out;
}

// GET every page of a list endpoint. Follows Link rel="next"; falls back to Total/Per-Page.
async function getAll(path, params, { apiKey, base, fetchImpl, sleep, log }) {
  const out = [];
  let url = new URL(base + path);
  for (const [k, v] of Object.entries({ ...params, per_page: API.perPage, page: 1 })) if (v !== undefined) url.searchParams.set(k, String(v));
  for (let guard = 0; guard < 500 && url; guard++) {
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${apiKey}`, Accept: API.accept } });
      if (res.status !== 429) break;
      log?.(`homebase api: rate limited on ${path}, backing off`);
      await sleep(15000 * (attempt + 1));
    }
    if (!res.ok) {
      const err = Error(`homebase api ${res.status} on ${path}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    const items = Array.isArray(body) ? body : arrayIn(body);
    out.push(...items);
    const links = parseLinkHeader(res.headers.get('link'));
    if (links.next) { url = new URL(links.next, base); continue; }
    const total = num(res.headers.get('total')), per = num(res.headers.get('per-page')) || API.perPage;
    const page = Number(url.searchParams.get('page') || 1);
    if (total !== null && page * per < total && items.length) { url = new URL(url); url.searchParams.set('page', String(page + 1)); continue; }
    url = null;
  }
  return out;
}

const OT_FIELDS = ['weekly_overtime', 'daily_overtime', 'double_overtime', 'seventh_day_overtime_15', 'seventh_day_overtime_20'];

// Public API Timecard (PublicApi_Entities_V1_Timecard) -> labor_shifts record.
export function mapApiTimecard(tc, location, tz = TZ) {
  const L = tc.labor || {};
  const store = canonicalStore(location?.name) || canonicalStore(location?.address_1);
  const clockIn = tc.clock_in ? Date.parse(tc.clock_in) : null;
  const clockOut = tc.clock_out ? Date.parse(tc.clock_out) : null;
  const ot = OT_FIELDS.reduce((s, f) => s + (num(L[f]) || 0), 0);
  const reg = num(L.regular_hours);
  const cash = num(L.cash_tips) || 0, credit = num(L.credit_tips) || 0;
  const salaried = /salar/i.test(L.wage_type || '');
  const employee = [tc.first_name, tc.last_name].filter(Boolean).join(' ').trim();
  const key = employeeKey(employee, tc.payroll_id);
  return {
    vendor: VENDOR,
    store,
    shift_id: clockIn ? laborShiftId(store, key, clockIn) : `${store || 'unknown'}|${key}|tc-${tc.id}`,
    business_date: clockIn ? businessDate(clockIn, tz) : null,
    employee,
    role: tc.role || null,
    clock_in: clockIn ? isoInZone(clockIn, tz) : null,
    clock_out: clockOut ? isoInZone(clockOut, tz) : null,
    regular_hours: reg === null ? null : round4(reg),
    ot_hours: round4(ot),
    wage_rate: num(L.wage_rate),
    labor_cost: num(L.costs) === null ? null : round2(num(L.costs)),
    tips_declared: round2(cash + credit),
    extra: {
      source: 'api', homebase_timecard_id: tc.id ?? null, employee_key: key,
      location_uuid: location?.uuid, location_name: location?.name,
      user_id: tc.user_id, payroll_id: tc.payroll_id || null, homebase_shift_id: tc.shift_id ?? null,
      department: tc.department || null, approved: tc.approved ?? null,
      wage_type: L.wage_type || null, salaried,
      paid_hours: num(L.paid_hours), unpaid_break_hours: num(L.unpaid_break_hours), break_penalty: num(L.break_penalty),
      scheduled_hours: num(L.scheduled_hours), cash_tips: cash, credit_tips: credit,
      ot_breakdown: Object.fromEntries(OT_FIELDS.map(f => [f, num(L[f]) || 0])),
      ot_computed: false, open: !clockOut,
    },
  };
}

// Public API Shift (PublicApi_Entities_V1_Shift) -> schedule_shifts record.
export function mapApiShift(sh, location, tz = TZ) {
  const L = sh.labor || {};
  const start = sh.start_at ? Date.parse(sh.start_at) : null;
  const end = sh.end_at ? Date.parse(sh.end_at) : null;
  const sched = num(L.scheduled_hours) ?? (start && end ? (end - start) / 3600000 - (num(L.scheduled_unpaid_breaks_hours) || 0) : null);
  const name = [sh.first_name, sh.last_name].filter(Boolean).join(' ').trim();
  const open = !!sh.open || isOpenShift(name);
  const employee = open ? 'OPEN' : name;
  const store = canonicalStore(location?.name) || canonicalStore(location?.address_1);
  const key = employeeKey(employee, null); // name only, see schedRecord
  return {
    vendor: VENDOR,
    store,
    shift_id: start ? scheduleShiftId(store, key, start, sh.role) : `${store || 'unknown'}|${key}|sh-${sh.id}`,
    business_date: start ? businessDate(start, tz) : null,
    employee,
    role: sh.role || null,
    start: start ? isoInZone(start, tz) : null,
    end: end ? isoInZone(end, tz) : null,
    scheduled_hours: sched === null ? null : round4(sched),
    scheduled_cost: num(L.scheduled_costs) === null ? null : round2(num(L.scheduled_costs)),
    extra: {
      source: 'api', homebase_shift_id: sh.id ?? null, employee_key: key, location_uuid: location?.uuid, location_name: location?.name,
      user_id: sh.user_id ?? null, timecard_id: sh.timecard_id ?? null, department: sh.department || null,
      wage_rate: num(sh.wage_rate), wage_type: L.wage_type || null, published: sh.published ?? null, open,
      scheduled_overtime: num(L.scheduled_overtime), scheduled_overtime_costs: num(L.scheduled_overtime_costs),
    },
  };
}

// apiCollect(creds, {from, through}, {fetchImpl}) -> {labor_shifts, schedule_shifts}
// creds: {apiKey, apiBase?, locations?: [uuid|name,...]}. Range is business dates (inclusive).
export async function apiCollect(creds, range, { fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {}, tz = TZ } = {}) {
  if (!creds?.apiKey) throw Error('homebase api: apiKey missing');
  const opts = { apiKey: creds.apiKey, base: creds.apiBase || API.base, fetchImpl, sleep, log };
  let locations = await getAll(API.locations(), {}, opts);
  if (Array.isArray(creds.locations) && creds.locations.length) locations = locations.filter(l => creds.locations.includes(l.uuid) || creds.locations.includes(l.name));
  const win = businessWindow(range.from, range.through, tz);
  const params = { start_date: isoInZone(win.start, tz), end_date: isoInZone(win.end - 1000, tz) };
  const labor_shifts = [], schedule_shifts = [];
  for (const loc of locations) {
    const store = canonicalStore(loc.name) || canonicalStore(loc.address_1);
    if (!store) { log(`homebase api: skipping unmapped location "${loc.name}"`); continue; }
    const tcs = await getAll(API.timecards(loc.uuid), { ...params, date_filter: 'clock_in' }, opts);
    labor_shifts.push(...tcs.map(t => mapApiTimecard(t, loc, tz)));
    const shs = await getAll(API.shifts(loc.uuid), { ...params, date_filter: 'start_at' }, opts);
    schedule_shifts.push(...shs.map(s => mapApiShift(s, loc, tz)));
  }
  const stats = { open_shifts_skipped: 0 };
  const sched = dropOpen(schedule_shifts, stats);
  return withStats({ labor_shifts: inRange(labor_shifts, range), schedule_shifts: inRange(sched, range) }, stats);
}

// ---------------------------------------------------------------- session mode (internal JSON)

// UNVERIFIED until confirmed with: npm run ops:record homebase
// Internal web-app routes used by app.joinhomebase.com for the Timesheets and Schedule pages.
export const ENDPOINTS = {
  origin: 'https://app.joinhomebase.com',
  locations: '/api/v1/locations',                                                   // UNVERIFIED
  timecards: (loc, from, to, page) => `/api/v1/locations/${loc}/timecards?start_date=${from}&end_date=${to}&page=${page}&per_page=100`, // UNVERIFIED
  shifts: (loc, from, to, page) => `/api/v1/locations/${loc}/shifts?start_date=${from}&end_date=${to}&page=${page}&per_page=100`,       // UNVERIFIED
  perPage: 100,
};

// UNVERIFIED until confirmed with: npm run ops:record homebase
export const SELECTORS = {
  email: 'input[type="email"], input[name="email"], input#email',
  password: 'input[type="password"], input[name="password"]',
  continue: 'button:has-text("Continue"), button:has-text("Next")',
  submit: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")',
  code: 'input[autocomplete="one-time-code"], input[name="code"], input[name*="verification"], input[inputmode="numeric"]',
  codeSubmit: 'button[type="submit"], button:has-text("Verify"), button:has-text("Continue")',
  signedInMarker: '[data-testid="nav-schedule"], a[href*="/schedule"], a[href*="/timesheets"]',
};

const LOGIN_URL = 'https://app.joinhomebase.com/accounts/sign-in';
const onSignIn = url => /\/(accounts\/)?sign[-_]?in|\/login/i.test(String(url || ''));

async function pageApiAll(ctx, mk) {
  const out = [];
  for (let page = 1; page < 200; page++) {
    const json = await ctx.api(ENDPOINTS.origin + mk(page));
    const items = arrayIn(json, ['data', 'timecards', 'shifts', 'locations', 'results', 'items']);
    out.push(...items);
    const next = pick(json, 'meta.next_page', 'next_page', 'pagination.next_page');
    if (next === undefined ? items.length < ENDPOINTS.perPage : !next) break;
  }
  return out;
}

// Internal JSON is assumed to mirror the public API entity shapes (the public API is a facade over
// the same models); pick() tolerates camelCase and flattened variants.
function normalizeInternal(x, kind) {
  const labor = x.labor || x.laborData || {};
  const base = {
    id: pick(x, 'id', 'uuid'),
    first_name: pick(x, 'first_name', 'user.first_name', 'employee.first_name'),
    last_name: pick(x, 'last_name', 'user.last_name', 'employee.last_name'),
    role: pick(x, 'role', 'role_name', 'role.name'), department: pick(x, 'department', 'department_name'),
    user_id: pick(x, 'user_id', 'user.id'), approved: pick(x, 'approved'), shift_id: pick(x, 'shift_id'),
    payroll_id: pick(x, 'payroll_id', 'user.payroll_id', 'employee.payroll_id'),
  };
  if (kind === 'timecard') {
    return { ...base, clock_in: pick(x, 'clock_in', 'start_at'), clock_out: pick(x, 'clock_out', 'end_at'),
      labor: { ...labor, regular_hours: pick(labor, 'regular_hours') ?? pick(x, 'regular_hours'), costs: pick(labor, 'costs') ?? pick(x, 'costs', 'labor_cost'),
        wage_rate: pick(labor, 'wage_rate') ?? pick(x, 'wage_rate'), wage_type: pick(labor, 'wage_type') ?? pick(x, 'wage_type'),
        paid_hours: pick(labor, 'paid_hours') ?? pick(x, 'paid_hours', 'total_hours'),
        weekly_overtime: pick(labor, 'weekly_overtime') ?? pick(x, 'weekly_overtime', 'overtime_hours'),
        cash_tips: pick(labor, 'cash_tips') ?? pick(x, 'cash_tips'), credit_tips: pick(labor, 'credit_tips') ?? pick(x, 'credit_tips') } };
  }
  return { ...base, open: pick(x, 'open'), published: pick(x, 'published'), wage_rate: pick(x, 'wage_rate'),
    start_at: pick(x, 'start_at', 'start'), end_at: pick(x, 'end_at', 'end'),
    labor: { ...labor, scheduled_hours: pick(labor, 'scheduled_hours') ?? pick(x, 'scheduled_hours'), scheduled_costs: pick(labor, 'scheduled_costs') ?? pick(x, 'scheduled_costs', 'scheduled_cost') } };
}

export async function sessionCollect(ctx, range, tz = TZ) {
  const locations = arrayIn(await ctx.api(ENDPOINTS.origin + ENDPOINTS.locations), ['data', 'locations', 'results']);
  const win = businessWindow(range.from, range.through, tz);
  const from = encodeURIComponent(isoInZone(win.start, tz)), to = encodeURIComponent(isoInZone(win.end - 1000, tz));
  const labor_shifts = [], schedule_shifts = [];
  for (const raw of locations) {
    const loc = { uuid: pick(raw, 'uuid', 'id'), name: pick(raw, 'name'), address_1: pick(raw, 'address_1', 'address') };
    if (!canonicalStore(loc.name) && !canonicalStore(loc.address_1)) { ctx.log?.(`homebase session: skipping unmapped location "${loc.name}"`); continue; }
    const tcs = await pageApiAll(ctx, p => ENDPOINTS.timecards(loc.uuid, from, to, p));
    labor_shifts.push(...tcs.map(t => mapApiTimecard(normalizeInternal(t, 'timecard'), loc, tz)).map(r => ({ ...r, extra: { ...r.extra, source: 'session' } })));
    const shs = await pageApiAll(ctx, p => ENDPOINTS.shifts(loc.uuid, from, to, p));
    schedule_shifts.push(...shs.map(s => mapApiShift(normalizeInternal(s, 'shift'), loc, tz)).map(r => ({ ...r, extra: { ...r.extra, source: 'session' } })));
  }
  const stats = { open_shifts_skipped: 0 };
  const sched = dropOpen(schedule_shifts, stats);
  return withStats({ labor_shifts: inRange(labor_shifts, range), schedule_shifts: inRange(sched, range) }, stats);
}

// ---------------------------------------------------------------- login (email + password + emailed code)

async function settle(page) {
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* best effort */ }
}

async function visible(page, sel, timeout = 4000) {
  try { await page.waitForSelector(sel, { state: 'visible', timeout }); return true; } catch { return false; }
}

export async function login(ctx) {
  const { page } = ctx;
  const { username, password } = ctx.creds || {};
  if (!username || !password) throw Error('homebase login: username/password missing from vault');
  const startedAt = new Date().toISOString();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.fill(SELECTORS.email, username);
  // Some Homebase sign-in variants ask for the email first, then reveal the password field.
  if (!(await visible(page, SELECTORS.password, 1500)) && (await visible(page, SELECTORS.continue, 1500))) await page.click(SELECTORS.continue);
  await page.fill(SELECTORS.password, password);
  await page.click(SELECTORS.submit);
  await settle(page);
  if (await visible(page, SELECTORS.code, 6000)) {
    ctx.log?.('homebase login: verification code requested, waiting for email');
    const code = await ctx.waitForEmailCode({ from: 'joinhomebase.com', after: startedAt, pattern: /\b(\d{4,8})\b/ });
    if (!code) throw Error('homebase login: no verification code arrived');
    await page.fill(SELECTORS.code, String(code));
    await page.click(SELECTORS.codeSubmit);
    await settle(page);
  }
  if (!(await isLoggedIn(ctx))) throw Error('homebase login: still on the sign-in page');
  return true;
}

export async function isLoggedIn(ctx) {
  const { page } = ctx;
  if (!page) return false;
  if (onSignIn(page.url())) return false;
  if (!/joinhomebase\.com/.test(page.url())) {
    await page.goto(`${ENDPOINTS.origin}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (onSignIn(page.url())) return false;
  }
  return visible(page, SELECTORS.signedInMarker, 5000);
}

// ---------------------------------------------------------------- files (Timesheets + Schedule exports)

// Column names ASSUMED from Homebase's web Timesheets download and the public API field names;
// aliases cover the common spellings. Confirm with a real export and add any new spelling here.
export const TIMESHEET_ALIASES = {
  employee: ['Employee', 'Employee Name', 'Name', 'Team Member', 'Full Name'],
  first: ['First Name', 'First'],
  last: ['Last Name', 'Last'],
  payroll_id: ['Payroll ID', 'Employee ID', 'Payroll Id'],
  role: ['Role', 'Position', 'Job'],
  department: ['Department'],
  location: ['Location', 'Location Name', 'Store'],
  date: ['Date', 'Shift Date', 'Clock In Date', 'Day'],
  clock_in: ['Clock In', 'Clock-In', 'Clock in time', 'In', 'Time In', 'Start'],
  clock_out: ['Clock Out', 'Clock-Out', 'Clock out time', 'Out', 'Time Out', 'End'],
  clock_out_date: ['Clock Out Date'],
  break_hours: ['Unpaid Breaks', 'Unpaid Break Hours', 'Break', 'Breaks', 'Break Hours', 'Break Duration'],
  regular_hours: ['Regular Hours', 'Regular', 'Reg Hours', 'Reg'],
  ot_hours: ['Overtime Hours', 'Overtime', 'OT Hours', 'OT', 'Weekly Overtime'],
  daily_ot: ['Daily Overtime', 'Daily OT'],
  double_ot: ['Double Overtime', 'Double OT', 'DT Hours'],
  paid_hours: ['Total Paid Hours', 'Paid Hours', 'Total Hours', 'Hours', 'Actual Hours'],
  wage_rate: ['Wage Rate', 'Wage', 'Hourly Rate', 'Rate', 'Pay Rate'],
  wage_type: ['Wage Type', 'Pay Type'],
  total_pay: ['Total Pay', 'Estimated Wages', 'Labor Cost', 'Wages', 'Total Wages', 'Gross Pay', 'Cost', 'Est Wages'],
  cash_tips: ['Cash Tips', 'Declared Cash Tips'],
  credit_tips: ['Credit Tips', 'Credit Card Tips', 'Card Tips'],
  tips: ['Tips', 'Total Tips', 'Declared Tips'],
};

export const SCHEDULE_ALIASES = {
  employee: ['Employee', 'Employee Name', 'Name', 'Team Member'],
  first: ['First Name'], last: ['Last Name'],
  payroll_id: ['Payroll ID', 'Employee ID', 'Payroll Id'],
  role: ['Role', 'Position'],
  department: ['Department'],
  location: ['Location', 'Location Name'],
  date: ['Date', 'Shift Date', 'Day'],
  start: ['Start', 'Start Time', 'Shift Start', 'From'],
  end: ['End', 'End Time', 'Shift End', 'To'],
  scheduled_hours: ['Scheduled Hours', 'Hours', 'Total Hours', 'Duration'],
  wage_rate: ['Wage Rate', 'Wage', 'Hourly Rate'],
  scheduled_cost: ['Scheduled Cost', 'Estimated Wages', 'Est Wages', 'Labor Cost', 'Cost', 'Scheduled Wages'],
  break_hours: ['Unpaid Breaks', 'Break', 'Breaks'],
};

const cell = (row, cols, f) => (cols[f] === undefined ? undefined : row[cols[f]]);
const nonEmpty = v => v !== undefined && v !== null && String(v).trim() !== '';

// Store from title rows ("Location: Betelgeuse Betelgeuse - Montrose"), filename, subject, or meta.store.
function storeFromContext(rows, headerIndex, meta) {
  for (let i = 0; i < headerIndex; i++) for (const c of rows[i]) { const s = canonicalStore(String(c)); if (s) return s; }
  return canonicalStore(meta?.store) || canonicalStore(meta?.filename) || canonicalStore(meta?.subject) || null;
}

function employeeName(row, cols) {
  const full = cell(row, cols, 'employee');
  if (nonEmpty(full)) {
    const s = String(full).trim();
    const m = /^([^,]+),\s*(.+)$/.exec(s); // "Last, First"
    return m ? `${m[2]} ${m[1]}` : s;
  }
  return [cell(row, cols, 'first'), cell(row, cols, 'last')].filter(nonEmpty).join(' ').trim();
}

export function parseTimesheets(rows, meta = {}, { tz = TZ, weekStart = 1 } = {}) {
  const hdr = findHeaderRow(rows, TIMESHEET_ALIASES, 3);
  if (!hdr || hdr.cols.clock_in === undefined) return [];
  const { cols } = hdr;
  const fallbackStore = storeFromContext(rows, hdr.index, meta);
  const out = [];
  let lastEmployee = '';
  const hasOt = cols.ot_hours !== undefined || cols.daily_ot !== undefined || cols.double_ot !== undefined;
  for (const row of rows.slice(hdr.index + 1)) {
    if (isTotalRow(row)) continue;
    const ciRaw = cell(row, cols, 'clock_in');
    if (!nonEmpty(ciRaw)) { const n = employeeName(row, cols); if (n) lastEmployee = n; continue; } // grouped exports put the name on its own row
    const employee = employeeName(row, cols) || lastEmployee;
    const dateStr = parseDate(cell(row, cols, 'date')) || parseTime(ciRaw)?.date;
    const inMs = combineDateTime(dateStr, ciRaw, { tz });
    if (inMs === null) continue;
    const coRaw = cell(row, cols, 'clock_out');
    const coDate = parseDate(cell(row, cols, 'clock_out_date'));
    const outMs = nonEmpty(coRaw) ? combineDateTime(coDate || dateStr, coRaw, { tz, after: coDate ? null : inMs }) : null;
    const breakH = hours(cell(row, cols, 'break_hours')) || 0;
    const reg = hours(cell(row, cols, 'regular_hours'));
    const ot = (hours(cell(row, cols, 'ot_hours')) || 0) + (hours(cell(row, cols, 'daily_ot')) || 0) + (hours(cell(row, cols, 'double_ot')) || 0);
    let paid = hours(cell(row, cols, 'paid_hours'));
    if (paid === null && reg !== null) paid = reg + ot;
    if (paid === null && outMs !== null) paid = (outMs - inMs) / 3600000 - breakH;
    const wage = num(cell(row, cols, 'wage_rate'));
    const wageType = cell(row, cols, 'wage_type');
    const salaried = /salar/i.test(String(wageType || '')) || (wage !== null && wage >= 1000); // annual salary in the wage column
    const total = num(cell(row, cols, 'total_pay'));
    const cash = num(cell(row, cols, 'cash_tips')), credit = num(cell(row, cols, 'credit_tips')), tipsAll = num(cell(row, cols, 'tips'));
    const store = canonicalStore(cell(row, cols, 'location')) || fallbackStore;
    const clockIn = isoInZone(inMs, tz);
    const payrollId = nonEmpty(cell(row, cols, 'payroll_id')) ? String(cell(row, cols, 'payroll_id')).trim() : null;
    const key = employeeKey(employee, payrollId);
    const rec = {
      vendor: VENDOR,
      store,
      shift_id: laborShiftId(store, key, inMs),
      business_date: businessDate(inMs, tz),
      employee,
      role: cell(row, cols, 'role') || null,
      clock_in: clockIn,
      clock_out: outMs === null ? null : isoInZone(outMs, tz),
      regular_hours: hasOt && reg !== null ? round4(reg) : null,
      ot_hours: hasOt ? round4(ot) : null,
      wage_rate: salaried ? null : wage,
      labor_cost: total !== null ? round2(total) : (!salaried && wage !== null && hasOt && reg !== null ? round2(reg * wage + ot * wage * 1.5) : null),
      tips_declared: round2((cash || 0) + (credit || 0) || tipsAll || 0),
      extra: {
        source: 'file', file: meta.filename || null, payroll_id: cell(row, cols, 'payroll_id') || null,
        department: cell(row, cols, 'department') || null, wage_type: wageType || (salaried ? 'salary' : null), salaried,
        annual_salary: salaried && wage !== null && wage >= 1000 ? wage : null,
        paid_hours: paid === null ? null : round4(paid), unpaid_break_hours: breakH, cash_tips: cash, credit_tips: credit,
        ot_computed: false, employee_key: key,
      },
    };
    if (!rec.store) rec.extra.store_unresolved = cell(row, cols, 'location') || null;
    out.push(rec);
  }
  if (!hasOt) {
    computeWeeklyOvertime(out, { weekStart });
    markPartialWeeks(out, weekStart);
  }
  for (const r of out) if (r.extra.salaried && r.regular_hours === null) { r.regular_hours = r.extra.paid_hours; r.ot_hours = 0; r.extra.ot_exempt = true; }
  return out;
}

// OT computed from one file only sees the hours in that file. A workweek the file does not cover end to
// end (the file starts after the week's first day or ends before its last) may be missing hours from
// another file, so its regular/OT split can be wrong. Those rows get extra.ot_partial_week = true.
// Coverage is the file's span of business dates (min..max), which is the best the export tells us.
function markPartialWeeks(shifts, weekStart) {
  const dates = shifts.map(s => s.business_date).filter(Boolean).sort();
  if (!dates.length) return;
  const first = dates[0], last = dates.at(-1);
  for (const s of shifts) {
    if (!s.extra?.ot_computed) continue;
    const ws = workweekStart(s.business_date, weekStart);
    const partial = ws < first || addDays(ws, 6) > last;
    s.extra.ot_partial_week = partial;
  }
}

// Grid layout: one row per employee, one column per day ("Mon 11/3"), cells like "5p-1a Bartender".
const DAY_HEADER = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|[a-z]{3}\s+\d{1,2})/i;
function parseScheduleGrid(rows, meta, tz) {
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) if (rows[i].filter(c => DAY_HEADER.test(String(c).trim())).length >= 3) { hi = i; break; }
  if (hi === -1) return [];
  const header = rows[hi];
  const year = Number(/\b(20\d{2})\b/.exec(rows.slice(0, hi + 1).flat().join(' ') + ' ' + (meta.filename || ''))?.[1]) || new Date().getUTCFullYear();
  const dayCols = header.map((c, i) => {
    const m = DAY_HEADER.exec(String(c).trim());
    if (!m) return null;
    let date = parseDate(m[2].includes('/') ? (m[2].split('/').length === 3 ? m[2] : `${m[2]}/${year}`) : `${m[2]} ${year}`);
    return date ? { i, date } : null;
  }).filter(Boolean);
  const store = storeFromContext(rows, hi, meta);
  const nameCol = Math.max(0, header.findIndex(c => /employee|name|team member/i.test(String(c))));
  const out = [];
  for (const row of rows.slice(hi + 1)) {
    const employee = String(row[nameCol] || '').trim();
    if (!employee || isTotalRow(row)) continue;
    for (const { i, date } of dayCols) {
      const text = String(row[i] || '').trim();
      if (!text) continue;
      for (const seg of text.split(/\n|;/)) {
        const m = /(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)\s*(.*)$/i.exec(seg.trim());
        if (!m) continue;
        const s = combineDateTime(date, m[1], { tz });
        const e = combineDateTime(date, m[2], { tz, after: s });
        out.push(schedRecord({ store, employee, role: m[3].replace(/^[\s·•|-]+/, '').trim() || null, s, e, cost: null, wage: null, breakH: 0, meta, tz, layout: 'grid' }));
      }
    }
  }
  return out;
}

function schedRecord({ store, employee, role, s, e, hoursVal, cost, wage, breakH, meta, tz, layout, payrollId = null }) {
  const sched = hoursVal ?? (e !== null ? (e - s) / 3600000 - (breakH || 0) : null);
  const startIso = isoInZone(s, tz);
  const open = isOpenShift(employee);
  // Schedule keys use the name only: the API Shift entity is not documented to carry payroll_id, and the
  // key must match across API, session and CSV. The id (when the export has one) stays in extra.
  const key = employeeKey(open ? 'OPEN' : employee, null);
  return {
    vendor: VENDOR, store, shift_id: scheduleShiftId(store, key, s, role),
    business_date: businessDate(s, tz), employee, role, start: startIso, end: e === null ? null : isoInZone(e, tz),
    scheduled_hours: sched === null ? null : round4(sched),
    scheduled_cost: cost !== null && cost !== undefined ? round2(cost) : (wage !== null && wage !== undefined && sched !== null ? round2(sched * wage) : null),
    extra: { source: 'file', file: meta.filename || null, layout, wage_rate: wage ?? null, employee_key: key, payroll_id: payrollId, open, ...(store ? {} : { store_unresolved: true }) },
  };
}

export function parseSchedule(rows, meta = {}, { tz = TZ } = {}) {
  const hdr = findHeaderRow(rows, SCHEDULE_ALIASES, 3);
  if (!hdr || hdr.cols.start === undefined) return parseScheduleGrid(rows, meta, tz);
  const { cols } = hdr;
  const fallbackStore = storeFromContext(rows, hdr.index, meta);
  const out = [];
  for (const row of rows.slice(hdr.index + 1)) {
    if (isTotalRow(row)) continue;
    const startRaw = cell(row, cols, 'start');
    if (!nonEmpty(startRaw)) continue;
    const date = parseDate(cell(row, cols, 'date')) || parseTime(startRaw)?.date;
    const s = combineDateTime(date, startRaw, { tz });
    if (s === null) continue;
    const endRaw = cell(row, cols, 'end');
    const e = nonEmpty(endRaw) ? combineDateTime(date, endRaw, { tz, after: s }) : null;
    const employee = employeeName(row, cols) || 'OPEN';
    out.push(schedRecord({
      store: canonicalStore(cell(row, cols, 'location')) || fallbackStore, employee, role: cell(row, cols, 'role') || null,
      s, e, hoursVal: hours(cell(row, cols, 'scheduled_hours')), cost: num(cell(row, cols, 'scheduled_cost')),
      wage: num(cell(row, cols, 'wage_rate')), breakH: hours(cell(row, cols, 'break_hours')) || 0, meta, tz, layout: 'rows',
      payrollId: nonEmpty(cell(row, cols, 'payroll_id')) ? String(cell(row, cols, 'payroll_id')).trim() : null,
    }));
  }
  return out;
}

const FILE_RE = /\.(csv|xlsx)$/i;
export function fileKind(meta = {}) {
  const s = `${meta.filename || ''} ${meta.subject || ''}`;
  if (/schedule|shifts?\b/i.test(s) && !/timesheet|timecard/i.test(s)) return 'schedule';
  if (/timesheet|timecard|time\s*card|payroll\s*summary|hours/i.test(s)) return 'timesheets';
  return null;
}

export function matchFile(meta = {}) {
  const fromHb = /joinhomebase\.com/i.test(meta.from || '');
  const named = FILE_RE.test(meta.filename || '') || /csv|spreadsheet/i.test(meta.mimeType || '');
  if (!named) return false;
  if (fromHb) return true;
  return /homebase/i.test(`${meta.filename} ${meta.subject}`) && fileKind(meta) !== null;
}

export function parseFile(buffer, meta = {}) {
  const rows = readTable(buffer, meta);
  const kind = fileKind(meta);
  const out = { labor_shifts: [], schedule_shifts: [] };
  const stats = { open_shifts_skipped: 0 };
  if (kind !== 'schedule') out.labor_shifts = parseTimesheets(rows, meta);
  if (kind === 'schedule' || (!out.labor_shifts.length && kind === null)) out.schedule_shifts = dropOpen(parseSchedule(rows, meta), stats);
  stats.ot_partial_week_rows = out.labor_shifts.filter(r => r.extra.ot_partial_week).length;
  // A file without a recognizable header set is not silently dropped: the caller sees zero records.
  return withStats(out, stats);
}

// ---------------------------------------------------------------- collect

export async function collect(ctx, range) {
  if (ctx.creds?.apiKey) {
    return apiCollect(ctx.creds, range, { fetchImpl: ctx.fetch || globalThis.fetch, log: ctx.log });
  }
  return sessionCollect(ctx, range);
}

export default {
  id: VENDOR,
  name: 'Homebase',
  domain: 'labor',
  modes: ['api', 'session', 'login', 'inbox', 'drive'],
  kinds: ['labor_shifts', 'schedule_shifts'],
  loginUrl: LOGIN_URL,
  handoffDomains: ['joinhomebase.com', 'app.joinhomebase.com'],
  login,
  isLoggedIn,
  collect,
  apiCollect,
  matchFile,
  parseFile,
};

// Exposed for tests.
export const _internal = { normalizeInternal, parseScheduleGrid, onSignIn, zonedToUtc, addDays, normHeader };
