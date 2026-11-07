// Toast Payroll (payroll.toasttab.com; formerly Toast Payroll & Team Management, built on StratEx)
// -> payroll_runs + payroll_lines.
//
// Modes, in order:
//   session  Handed-off session (Toast sign-in is bot-checked, so there is no login()). Internal JSON
//            via ctx.api (ENDPOINTS UNVERIFIED), falling back to downloading each payroll's Employee
//            Detail / Payroll Register report through the UI (SELECTORS UNVERIFIED) and parsing it.
//   inbox / drive  Payroll Register / Employee Detail / PEPAR exports, CSV or XLSX. Toast's help
//            center does not publish column names or file types, so headers are matched by alias and
//            tax columns are classified employee-vs-employer by name. See LABOR.md.
import { canonicalStore } from '../core/stores.mjs';
import {
  round2, round4, num, hours, stableId, normHeader, findHeaderRow, isTotalRow, readTable, parseDate, arrayIn, pick,
} from './_labor-common.mjs';

const VENDOR = 'toast-payroll';
const ORIGIN = 'https://payroll.toasttab.com';

// ---------------------------------------------------------------- file parsing

// Identity / period / hours columns. Money columns are classified separately (classifyMoney).
export const LINE_ALIASES = {
  employee: ['Employee', 'Employee Name', 'Name', 'Team Member', 'Employee Full Name'],
  first: ['First Name', 'Employee First Name'],
  last: ['Last Name', 'Employee Last Name'],
  employee_id: ['Employee ID', 'Employee Id', 'Emp ID', 'Employee Number', 'Emp #', 'Badge ID', 'Payroll ID'],
  location: ['Location', 'Work Location', 'Restaurant', 'Store', 'Department', 'Home Location', 'Company', 'Company Name', 'Legal Entity'],
  fein: ['FEIN', 'Company FEIN', 'EIN'],
  check_date: ['Check Date', 'Pay Date', 'Payment Date', 'Payroll Date'],
  period_start: ['Period Start', 'Pay Period Start', 'Period Begin', 'Pay Period Begin', 'Period Start Date', 'Start Date', 'Begin Date'],
  period_end: ['Period End', 'Pay Period End', 'Period End Date', 'End Date'],
  pay_period: ['Pay Period', 'Period'],
  payroll_id: ['Payroll Run', 'Payroll Run ID', 'Run ID', 'Batch ID', 'Payroll Name'],
  pay_type: ['Pay Type', 'Wage Type', 'Compensation Type', 'Salary/Hourly', 'Earning Type'],
  regular_hours: ['Regular Hours', 'Reg Hours', 'Regular Hrs', 'Hours - Regular', 'Regular (Hours)'],
  ot_hours: ['Overtime Hours', 'OT Hours', 'Overtime Hrs', 'Hours - Overtime', 'Overtime (Hours)'],
  total_hours: ['Total Hours', 'Hours', 'Hours Worked'],
};

// Money columns, by normalized header. Order matters: first match wins.
const MONEY_RULES = [
  ['gross', /^(total )?gross( pay| wages| earnings)?( amount)?$|^total earnings$/],
  ['net', /^net( pay| check| amount)?$/],
  ['er_tax_total', /^(total )?(employer|er|company) (paid )?tax(es)?( total)?$|^employer tax(es)? total$/],
  ['ee_tax_total', /^(total )?(employee|ee) (paid )?tax(es)?( total)?$|^(total )?(tax )?withholdings?$|^taxes withheld$/],
  ['tax_total', /^(total )?taxes$/],
  ['er_benefit_total', /^(total )?(employer|er|company) (paid )?(benefits?|contributions?|deductions?)( total)?$/],
  ['ee_deduction_total', /^(total )?(employee |ee )?(pre tax |post tax )?deductions?( total)?$/],
  ['tips', /tip/],
  ['er_tax', /\b(er|employer|company)\b.*\b(tax|ss|soc(ial)? sec(urity)?|oasdi|medicare|futa|suta|sui|fui|unemployment|twc)\b|\b(tax|ss|soc(ial)? sec(urity)?|oasdi|medicare|futa|suta|sui|fui)\b.*\b(er|employer|company)\b|^(futa|suta|sui|fui|tx sui|tx suta|texas sui|twc)\b|\bunemployment\b/],
  ['er_benefit', /\b(er|employer|company)\b.*\b(health|medical|dental|vision|401 ?k|retirement|benefit|insurance|match|hsa)\b|\b(health|medical|dental|vision|401 ?k|benefit|match|hsa)\b.*\b(er|employer|company)\b/],
  ['ee_tax', /\b(ee|employee)\b.*\b(tax|ss|soc(ial)? sec(urity)?|oasdi|medicare)\b|\b(ss|soc(ial)? sec(urity)?|oasdi|medicare)\b.*\b(ee|employee)\b|^(fit|sit|federal( income)?( tax| withholding)?|fed( income)? tax|federal income tax|state income tax|local tax|social security|medicare|oasdi|fica)\b/],
  ['regular_pay', /^(regular|reg)( pay| earnings| wages)?( amount| \$)?$|^regular amount$/],
  ['ot_pay', /^(overtime|ot)( pay| earnings| wages)?( amount| \$)?$|^overtime amount$/],
  ['salary_pay', /^salary( pay| earnings| amount)?$/],
  ['ee_deduction', /deduction|garnish|401 ?k|health|dental|vision|child support|loan|advance/],
];
// Columns that are never money even if numeric.
const NOT_MONEY = /hours?|hrs|rate|date|period|id$|^id|number|fein|ein|ssn|zip|check (no|number|#)|^#|count/;

export function classifyMoney(header) {
  const h = normHeader(header);
  if (!h || NOT_MONEY.test(h)) return null;
  for (const [cls, re] of MONEY_RULES) if (re.test(h)) return cls;
  return null;
}

const cell = (row, i) => (i === undefined ? undefined : row[i]);
const nonEmpty = v => v !== undefined && v !== null && String(v).trim() !== '';

// Natural keys. Identical on every acquisition path (session JSON, session download, inbox, drive),
// so the same payroll collected two ways upserts onto one row instead of being stored twice.
// Toast's own payroll id (session) or a run column (file) is kept in extra.toast_run_id.
export const runKey = (store, checkDate, periodStart, periodEnd) => `${store || 'unknown'}|${checkDate || ''}|${periodStart || ''}|${periodEnd || ''}`;
// Same-name employees stay separate when an employee id/number is available.
export const employeeLabel = (name, id) => (nonEmpty(id) ? `${name} #${String(id).trim()}` : name);

function storeFromContext(rows, headerIndex, meta) {
  for (let i = 0; i < headerIndex; i++) for (const c of rows[i]) { const s = canonicalStore(String(c)); if (s) return s; }
  return canonicalStore(meta?.store) || canonicalStore(meta?.filename) || canonicalStore(meta?.subject) || null;
}
function datesFromContext(rows, headerIndex, meta) {
  const text = rows.slice(0, headerIndex).flat().join(' ') + ' ' + (meta?.subject || '') + ' ' + (meta?.filename || '');
  const check = /(?:check|pay)\s*date\s*:?\s*([0-9/.-]{8,10})/i.exec(text)?.[1];
  const per = /(?:pay\s*)?period\s*:?\s*([0-9/.-]{8,10})\s*(?:-|–|to|through)\s*([0-9/.-]{8,10})/i.exec(text);
  return { check_date: parseDate(check), period_start: parseDate(per?.[1]), period_end: parseDate(per?.[2]) };
}

// Parses an employee-level payroll export (one row per employee per check) into lines + runs.
export function parsePayrollRows(rows, meta = {}) {
  const hdr = findHeaderRow(rows, LINE_ALIASES, 2);
  if (!hdr) return { payroll_runs: [], payroll_lines: [] };
  const header = rows[hdr.index];
  const { cols } = hdr;
  const idCols = new Set(Object.values(cols));
  const money = header.map((h, i) => (idCols.has(i) ? null : classifyMoney(h)));
  const ctxStore = storeFromContext(rows, hdr.index, meta);
  const ctxDates = datesFromContext(rows, hdr.index, meta);
  const lines = [];
  let lastEmployee = '';
  for (const row of rows.slice(hdr.index + 1)) {
    if (isTotalRow(row)) continue;
    let employee = nonEmpty(cell(row, cols.employee)) ? String(cell(row, cols.employee)).trim() : [cell(row, cols.first), cell(row, cols.last)].filter(nonEmpty).join(' ').trim();
    const m = /^([^,]+),\s*(.+)$/.exec(employee);
    if (m) employee = `${m[2]} ${m[1]}`;
    const sums = {};
    const detail = {};
    let anyMoney = false;
    money.forEach((cls, i) => {
      if (!cls) return;
      const v = num(row[i]);
      if (v === null) return;
      anyMoney = true;
      sums[cls] = (sums[cls] || 0) + v;
      detail[normHeader(header[i]).replace(/ /g, '_')] = v;
    });
    if (!employee) employee = lastEmployee;
    if (!employee || !anyMoney) { if (employee) lastEmployee = employee; continue; }
    lastEmployee = employee;
    const per = String(cell(row, cols.pay_period) || '');
    const perM = /([0-9/.-]{8,10})\s*(?:-|–|to|through)\s*([0-9/.-]{8,10})/.exec(per);
    const check_date = parseDate(cell(row, cols.check_date)) || ctxDates.check_date;
    const period_start = parseDate(cell(row, cols.period_start)) || parseDate(perM?.[1]) || ctxDates.period_start;
    const period_end = parseDate(cell(row, cols.period_end)) || parseDate(perM?.[2]) || ctxDates.period_end;
    const store = canonicalStore(cell(row, cols.location)) || ctxStore;
    const regH = hours(cell(row, cols.regular_hours));
    const otH = hours(cell(row, cols.ot_hours));
    const totH = hours(cell(row, cols.total_hours));
    const earningsParts = (sums.regular_pay || 0) + (sums.ot_pay || 0) + (sums.salary_pay || 0) + (sums.tips || 0);
    const gross = sums.gross ?? (earningsParts || null);
    const er = sums.er_tax_total ?? (sums.er_tax !== undefined ? sums.er_tax : null);
    const ee = sums.ee_tax_total ?? (sums.ee_tax !== undefined ? sums.ee_tax : (sums.tax_total !== undefined && er !== null ? sums.tax_total - er : null));
    const benefits = sums.er_benefit_total ?? sums.er_benefit ?? 0;
    const payType = String(cell(row, cols.pay_type) || '');
    const salaried = /salar/i.test(payType) || (!!sums.salary_pay && !regH && !otH);
    const runCell = cols.payroll_id !== undefined && cols.payroll_id !== cols.employee_id ? cell(row, cols.payroll_id) : undefined;
    const toastRunId = nonEmpty(runCell) ? String(runCell).trim() : null;
    const employeeId = cols.employee_id !== undefined && nonEmpty(cell(row, cols.employee_id)) ? String(cell(row, cols.employee_id)).trim() : null;
    lines.push({
      vendor: VENDOR,
      run_id: runKey(store, check_date, period_start, period_end),
      employee: employeeLabel(employee, employeeId),
      store,
      gross_wages: gross === null ? null : round2(gross),
      regular_hours: regH === null ? (salaried ? null : totH !== null && otH !== null ? round4(totH - otH) : totH) : round4(regH),
      ot_hours: otH === null ? (regH !== null || totH !== null ? 0 : null) : round4(otH),
      tips: round2(sums.tips || 0),
      employer_taxes: er === null ? null : round2(er),
      extra: {
        source: 'file', file: meta.filename || null, toast_run_id: toastRunId,
        employee_name: employee, employee_id: employeeId,
        fein: cell(row, cols.fein) || null, pay_type: payType || (salaried ? 'Salary' : null), salaried,
        check_date, period_start, period_end,
        employee_taxes: ee === null ? null : round2(ee),
        employer_benefits: round2(benefits),
        employee_deductions: round2(sums.ee_deduction_total ?? sums.ee_deduction ?? 0),
        net_pay: sums.net === undefined ? null : round2(sums.net),
        regular_pay: sums.regular_pay ?? null, ot_pay: sums.ot_pay ?? null, salary_pay: sums.salary_pay ?? null,
        gross_ex_tips: gross === null ? null : round2(gross - (sums.tips || 0)),
        columns: detail,
        ...(store ? {} : { store_unresolved: cell(row, cols.location) || null }),
      },
    });
  }
  return { payroll_lines: lines, payroll_runs: rollupRuns(lines) };
}

export function rollupRuns(lines) {
  const runs = new Map();
  for (const l of lines) {
    let r = runs.get(l.run_id);
    if (!r) {
      r = { vendor: VENDOR, store: l.store, run_id: l.run_id, pay_date: l.extra.check_date || null, period_start: l.extra.period_start || null, period_end: l.extra.period_end || null,
        gross_wages: 0, employer_taxes: 0, benefits: 0, total_cost: 0, employee_count: 0,
        extra: { employee_taxes: 0, tips: 0, wages_ex_tips: 0, salaried_gross: 0, hourly_gross: 0, regular_hours: 0, ot_hours: 0, net_pay: 0, source: l.extra.source, file: l.extra.file || null, toast_run_id: null } };
      runs.set(l.run_id, r);
    }
    if (l.extra.toast_run_id) {
      const ids = new Set(String(r.extra.toast_run_id || '').split(',').filter(Boolean)).add(String(l.extra.toast_run_id));
      r.extra.toast_run_id = [...ids].join(',');
    }
    if (r.store !== l.store) r.extra.mixed_stores = true;
    r.gross_wages += l.gross_wages || 0;
    r.employer_taxes += l.employer_taxes || 0;
    r.benefits += l.extra.employer_benefits || 0;
    r.employee_count += 1;
    r.extra.employee_taxes += l.extra.employee_taxes || 0;
    r.extra.tips += l.tips || 0;
    r.extra[l.extra.salaried ? 'salaried_gross' : 'hourly_gross'] += l.gross_wages || 0;
    r.extra.regular_hours += l.regular_hours || 0;
    r.extra.ot_hours += l.ot_hours || 0;
    r.extra.net_pay += l.extra.net_pay || 0;
  }
  for (const r of runs.values()) {
    for (const k of ['gross_wages', 'employer_taxes', 'benefits']) r[k] = round2(r[k]);
    for (const k of ['employee_taxes', 'tips', 'salaried_gross', 'hourly_gross', 'net_pay']) r.extra[k] = round2(r.extra[k]);
    // Gross wages include tips paid through payroll; wages_ex_tips is the wage cost for labor %.
    r.extra.wages_ex_tips = round2(r.gross_wages - r.extra.tips);
    for (const k of ['regular_hours', 'ot_hours']) r.extra[k] = round4(r.extra[k]);
    // Employer cost of the run: gross wages + employer taxes + employer-paid benefits.
    r.total_cost = round2(r.gross_wages + r.employer_taxes + r.benefits);
  }
  return [...runs.values()];
}

export function matchFile(meta = {}) {
  const tabular = /\.(csv|xlsx)$/i.test(meta.filename || '') || /csv|spreadsheet|excel/i.test(meta.mimeType || '');
  if (!tabular) return false;
  const text = `${meta.filename || ''} ${meta.subject || ''}`;
  const fromToast = /toasttab\.com/i.test(meta.from || '');
  const payrollish = /payroll|register|pepar|employee detail|earnings|paystub|pay stub/i.test(text);
  if (fromToast) return payrollish;
  return payrollish && /toast|pepar|payroll register|employee detail/i.test(text);
}

export function parseFile(buffer, meta = {}) {
  return parsePayrollRows(readTable(buffer, meta), meta);
}

// ---------------------------------------------------------------- session mode

// UNVERIFIED until confirmed with: npm run ops:record toast-payroll
// Toast documents the UI paths (Payroll > Past Payrolls > View; Reports > Standard) on
// payroll.toasttab.com but not the JSON routes behind them.
export const ENDPOINTS = {
  origin: ORIGIN,
  pastPayrolls: (from, through) => `/api/payroll/v1/payrolls?status=posted&checkDateFrom=${from}&checkDateTo=${through}`, // UNVERIFIED
  payrollDetail: id => `/api/payroll/v1/payrolls/${encodeURIComponent(id)}/employee-details`,                       // UNVERIFIED
};

// UNVERIFIED until confirmed with: npm run ops:record toast-payroll
export const SELECTORS = {
  signedInMarker: 'nav a[href*="payroll"], [data-testid="global-nav"], a:has-text("Past Payrolls")',
  payrollMenu: 'a:has-text("Payroll"), button:has-text("Payroll")',
  pastPayrollsTab: 'a:has-text("Past Payrolls"), button:has-text("Past Payrolls"), [role="tab"]:has-text("Past Payrolls")',
  pastPayrollRow: 'table tbody tr, [data-testid="past-payroll-row"]',
  rowCheckDate: 'td:nth-child(1), [data-testid="check-date"]',
  rowView: 'a:has-text("View"), button:has-text("View")',
  reportsTile: 'button:has-text("Reports"), a:has-text("Reports")',
  employeeDetailReport: 'a:has-text("Employee Detail"), button:has-text("Employee Detail"), a:has-text("Payroll Register")',
  exportExcel: 'button:has-text("Excel"), a:has-text("Excel"), button:has-text("CSV"), a:has-text("CSV"), button:has-text("Export"), a:has-text("Download")',
};

// Internal JSON payroll -> lines (assumed shape; pick() tolerates camelCase/snake_case variants).
export function mapApiPayroll(run, details, { storeHint } = {}) {
  const toastRunId = String(pick(run, 'id', 'payrollId', 'uuid'));
  const store = canonicalStore(pick(run, 'locationName', 'location.name', 'companyName', 'company.name', 'restaurantName')) || canonicalStore(storeHint);
  const check_date = parseDate(pick(run, 'checkDate', 'payDate'));
  const period_start = parseDate(pick(run, 'periodStart', 'payPeriodStart', 'payPeriod.start'));
  const period_end = parseDate(pick(run, 'periodEnd', 'payPeriodEnd', 'payPeriod.end'));
  const lines = arrayIn(details, ['employees', 'employeeDetails', 'checks', 'data', 'items']).map(e => {
    const taxes = arrayIn(pick(e, 'taxes') || []);
    const sumTaxes = pred => taxes.filter(pred).reduce((s, t) => s + (num(pick(t, 'amount', 'value')) || 0), 0);
    const isEr = t => /employer|^er$|company/i.test(String(pick(t, 'paidBy', 'payer', 'type') || '')) || pick(t, 'employerPaid') === true;
    const erTax = num(pick(e, 'employerTaxes', 'totals.employerTaxes')) ?? (taxes.length ? sumTaxes(isEr) : null);
    const eeTax = num(pick(e, 'employeeTaxes', 'totals.employeeTaxes')) ?? (taxes.length ? sumTaxes(t => !isEr(t)) : null);
    const earnings = arrayIn(pick(e, 'earnings') || []);
    const sumEarn = re => earnings.filter(x => re.test(String(pick(x, 'name', 'code', 'type') || ''))).reduce((s, x) => s + (num(pick(x, 'amount')) || 0), 0);
    const hrs = re => earnings.filter(x => re.test(String(pick(x, 'name', 'code', 'type') || ''))).reduce((s, x) => s + (num(pick(x, 'hours')) || 0), 0);
    const tips = num(pick(e, 'tips', 'totals.tips')) ?? sumEarn(/tip/i);
    const gross = num(pick(e, 'grossPay', 'grossWages', 'gross', 'totals.gross'));
    const salaried = /salar/i.test(String(pick(e, 'payType', 'compensationType') || '')) || (sumEarn(/salary/i) > 0 && !hrs(/reg/i));
    const lineStore = canonicalStore(pick(e, 'locationName', 'location.name', 'workLocation')) || store;
    let name = String(pick(e, 'employeeName', 'name', 'employee.name') || [pick(e, 'firstName'), pick(e, 'lastName')].filter(Boolean).join(' ')).trim();
    const nm = /^([^,]+),\s*(.+)$/.exec(name);
    if (nm) name = `${nm[2]} ${nm[1]}`;
    // Prefer the employee number (what the exports show) over an internal id.
    const employeeId = pick(e, 'employeeNumber', 'employee.number', 'employeeId', 'employee.id') ?? null;
    return {
      vendor: VENDOR, run_id: runKey(lineStore, check_date, period_start, period_end), employee: employeeLabel(name, employeeId),
      store: lineStore,
      gross_wages: gross === null ? null : round2(gross),
      regular_hours: num(pick(e, 'regularHours', 'hours.regular')) ?? (earnings.length && !salaried ? round4(hrs(/reg/i)) : null),
      ot_hours: num(pick(e, 'overtimeHours', 'hours.overtime')) ?? (earnings.length ? round4(hrs(/overtime|\bot\b/i)) : 0),
      tips: round2(tips || 0),
      employer_taxes: erTax === null ? null : round2(erTax),
      extra: { source: 'session', toast_run_id: toastRunId, check_date, period_start, period_end, salaried, employee_taxes: eeTax === null ? null : round2(eeTax),
        employer_benefits: round2(num(pick(e, 'employerBenefits', 'employerContributions', 'totals.employerBenefits')) || 0),
        net_pay: num(pick(e, 'netPay', 'totals.netPay')), employee_name: name, employee_id: employeeId === null ? null : String(employeeId),
        gross_ex_tips: gross === null ? null : round2(gross - (tips || 0)) },
    };
  });
  return lines;
}

async function downloadViaUi(ctx, range) {
  const { page } = ctx;
  const out = { payroll_runs: [], payroll_lines: [] };
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.click(SELECTORS.payrollMenu).catch(() => {});
  await page.click(SELECTORS.pastPayrollsTab);
  const rows = await page.$$(SELECTORS.pastPayrollRow);
  const targets = [];
  for (let i = 0; i < rows.length; i++) {
    const text = await (await rows[i].$(SELECTORS.rowCheckDate))?.textContent?.() ?? await rows[i].textContent();
    const d = parseDate(text);
    if (d && d >= range.from && d <= range.through) targets.push(i);
  }
  for (const i of targets) {
    const row = (await page.$$(SELECTORS.pastPayrollRow))[i];
    await (await row.$(SELECTORS.rowView)).click();
    await page.click(SELECTORS.reportsTile).catch(() => {});
    const [download] = await Promise.all([page.waitForEvent('download'), page.click(SELECTORS.employeeDetailReport).then(() => page.click(SELECTORS.exportExcel).catch(() => {}))]);
    const filename = download.suggestedFilename();
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const parsed = parseFile(Buffer.concat(chunks), { filename });
    if (!parsed.payroll_lines.length) ctx.log?.(`toast-payroll: downloaded ${filename} but found no payroll rows`);
    for (const l of parsed.payroll_lines) l.extra.source = 'session-download';
    out.payroll_lines.push(...parsed.payroll_lines);
    await page.goBack().catch(() => {});
    await page.click(SELECTORS.pastPayrollsTab).catch(() => {});
  }
  out.payroll_runs = rollupRuns(out.payroll_lines);
  return out;
}

export async function collect(ctx, range) {
  try {
    const list = arrayIn(await ctx.api(ORIGIN + ENDPOINTS.pastPayrolls(range.from, range.through)), ['payrolls', 'data', 'items', 'results']);
    const lines = [];
    for (const run of list) {
      const id = pick(run, 'id', 'payrollId', 'uuid');
      const check = parseDate(pick(run, 'checkDate', 'payDate'));
      if (!id || (check && (check < range.from || check > range.through))) continue;
      const details = await ctx.api(ORIGIN + ENDPOINTS.payrollDetail(id));
      lines.push(...mapApiPayroll(run, details));
    }
    return { payroll_lines: lines, payroll_runs: rollupRuns(lines).map(r => ({ ...r, extra: { ...r.extra, source: 'session' } })) };
  } catch (e) {
    if (!ctx.page) throw e;
    ctx.log?.(`toast-payroll: internal JSON failed (${e.status || e.message}); falling back to report download`);
    return downloadViaUi(ctx, range);
  }
}

export async function isLoggedIn(ctx) {
  const { page } = ctx;
  if (!page) return false;
  if (!/payroll\.toasttab\.com/.test(page.url())) await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (/auth\.toasttab\.com|\/login|sign-?in/i.test(page.url())) return false;
  try { await page.waitForSelector(SELECTORS.signedInMarker, { state: 'visible', timeout: 5000 }); return true; } catch { return false; }
}

export default {
  id: VENDOR,
  name: 'Toast Payroll',
  domain: 'payroll',
  modes: ['session', 'inbox', 'drive'],
  kinds: ['payroll_runs', 'payroll_lines'],
  loginUrl: `${ORIGIN}/`,
  handoffDomains: ['toasttab.com', 'payroll.toasttab.com', 'auth.toasttab.com'],
  isLoggedIn,
  collect,
  matchFile,
  parseFile,
};

export const _internal = { stableId, downloadViaUi };
