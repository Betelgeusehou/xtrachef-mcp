# Labor + payroll adapters

| File | What it does |
|---|---|
| `homebase.mjs` | Homebase (scheduling, time clock) -> `labor_shifts`, `schedule_shifts` |
| `toast-payroll.mjs` | Toast Payroll (payroll.toasttab.com) -> `payroll_runs`, `payroll_lines` |
| `_labor-common.mjs` | CSV/XLSX reading (no deps), header aliasing, Chicago time math, business date, FLSA overtime |
| `labor.test.mjs` | `node --test ops/vendors/labor.test.mjs` |
| `fixtures/labor/` | Synthetic exports: both stores, an overnight shift, a 48.5-hour week, a salaried manager |

## Rules both adapters apply

- **Business date.** The bars close at 2 AM. A shift that clocks in before 4:00 AM America/Chicago
  belongs to the previous business date. This matches `businessPeriod()` in
  `dashboard/prime-cost-model.mjs`, which treats a day as complete at 4 AM. DST is handled.
- **Overtime.** Texas follows the federal FLSA rule: 1.5x for hours over 40 in a workweek, with no daily OT.
  When a timesheet has no OT split, `computeWeeklyOvertime` assigns regular and OT hours per employee per
  workweek, in clock-in order. The workweek starts Monday by default and can be configured. It recomputes
  `labor_cost` as `reg*rate + ot*rate*1.5` and sets `extra.ot_computed = true`. When the source already
  splits OT (the Homebase API, or an export with OT columns), that split is used as given and
  `ot_computed` is `false`. Salaried rows are exempt: `extra.salaried = true`, `wage_rate`/`labor_cost`
  are `null`, `ot_hours = 0`.
- **Stores.** `canonicalStore()` from `ops/core/stores.mjs` maps names like
  `"Betelgeuse Betelgeuse - Montrose"`. Order of preference: the row's Location column, then the
  report's title rows, then the filename/subject. A row that can't be mapped keeps `store: null` and
  `extra.store_unresolved` instead of being guessed. In API and session mode, locations that don't map
  (for example a commissary) are skipped and logged.
- **Totals rows** ("Totals", "Grand Total") are skipped. Grouped exports that put the employee
  name on its own row are handled.

## Homebase

**Homebase has a usable, documented API.** It is read-only and the key is approved per account.

- Docs: Swagger at <https://app.joinhomebase.com/api/public/swagger_doc.json> ("Homebase Public API",
  fetched 2026-11-07).
- Key: request it at <https://app.joinhomebase.com/settings/api>. Per the docs, "Once our team approves
  your request, you'll be able to see it in that same Settings page." Third-party sources (supergood.ai,
  TipHaus) disagree on which plan includes it and say approval takes about 24–48 hours.
- Auth: `Authorization: Bearer <key>` and `Accept: application/vnd.homebase-v1+json`.
- Base: `https://app.joinhomebase.com/api/public` (the swagger host and basePath). The docs' curl example
  uses `https://api.joinhomebase.com`; `creds.apiBase` overrides the base.
- Endpoints used: `GET /locations`; `GET /locations/{uuid}/timecards?start_date&end_date&date_filter=clock_in&page&per_page`;
  `GET /locations/{uuid}/shifts?start_date&end_date&date_filter=start_at&page&per_page`.
- Pagination follows `Link: <...>; rel="next"` (RFC-5988), with a fallback to `Total`/`Per-Page`.
  Rate limit: 60 requests/min per UUID. A 429 backs off and retries.
- Mapping: the Timecard `labor` fields map as follows. `regular_hours` -> `regular_hours`. The sum of
  `weekly_overtime + daily_overtime + double_overtime + seventh_day_*` -> `ot_hours`. `costs` -> `labor_cost`.
  `cash_tips + credit_tips` -> `tips_declared`. `wage_rate` and `wage_type` are kept as-is. Shift
  `labor.scheduled_hours/scheduled_costs` -> `schedule_shifts`. The query window is the business-date
  window: `from` 04:00 local through `through+1` 03:59:59 local.

**Session mode** (`ENDPOINTS`, `SELECTORS`): UNVERIFIED until confirmed with `npm run ops:record homebase`.
The internal JSON is assumed to mirror the public entity shapes; `pick()` accepts camelCase variants too.
**Login**: email + password on `https://app.joinhomebase.com/accounts/sign-in`. That URL is the sign-in
link the swagger page itself uses. The selectors are UNVERIFIED. The email-first variant is handled. If a
code screen appears, the code is read with `ctx.waitForEmailCode({from: 'joinhomebase.com'})`.

**Files** (inbox/drive): Timesheets export and Schedule export, CSV or XLSX. Homebase does not publish
the export column names, so the headers are ASSUMED. They are aliased broadly (`TIMESHEET_ALIASES`,
`SCHEDULE_ALIASES`), based on the web UI labels and the API field names. Schedule exports in both
row-per-shift and grid ("Mon 10/19" columns, cells like `5p-1a Bartender`) layouts are parsed. Annual
salary in the wage column (>= 1000) marks the row salaried.

### Contract extension: `api` mode

The README's `ctx` has no helper for API-key vendors. Homebase adds:

- `modes: ['api', 'session', 'login', 'inbox', 'drive']`
- `export async function apiCollect(creds, range, {fetchImpl, sleep, log})`. This is plain `fetch`
  with the key, with no browser.
- `collect(ctx, range)` calls `apiCollect(ctx.creds, range, {fetchImpl: ctx.fetch || fetch})` when
  `ctx.creds.apiKey` is set. That way the existing runner, which only calls `collect` inside a session,
  works unchanged. A runner that understands `api` mode can call `apiCollect` directly and skip
  Playwright entirely.

## Toast Payroll

- Portal: <https://payroll.toasttab.com>. Toast's help center documents these reports:
  - **Payroll > Past Payrolls > View**: Payroll Summary (earnings, deductions, taxes, "employee-paid vs.
    employer-paid taxes"), Employee Detail (one paystub per page; its title is "Payroll Register Report"),
    Payroll Exception, Labor Distribution, Check Register, Journal Entry.
  - **Reports > Standard**: PEPAR (per-pay-period audit: earnings, deductions, taxes; adjustable fields;
    HR+ role), Hours / Earnings by Date Range, and Consolidated Payroll Summary. Standard reports either
    download immediately or go to the **Document Courier**.
  - Sources: [Payroll Register](https://support.toasttab.com/en/article/Payroll-Register-Report),
    [Common Payroll Reports](https://support.toasttab.com/en/article/Toast-Payroll-Most-Commonly-Used-Reports),
    [Payroll Summary](https://support.toasttab.com/en/article/Toast-Payroll-Payroll-Summary-Report),
    [Report Library](https://support.toasttab.com/en/article/Toast-Payroll-Report-Library),
    [Export Employee Data](https://support.toasttab.com/en/article/Toast-Payroll-Export-Employee-Data).
- **Not documented anywhere public:** the file types (the articles say the reports open "in a spreadsheet
  program") and the column headers. Scheduled or emailed delivery of payroll reports is not mentioned either.
  The parser therefore accepts **CSV and XLSX** (XLSX through the built-in reader) and classifies every
  money column by header name:
  `gross`, `net`, `tips`, `er_tax` (e.g. "Social Security - ER", "FUTA", "TX SUI"), `ee_tax`
  ("Federal Income Tax", "Medicare - EE"), `er_benefit` ("Health Insurance - ER"), `ee_deduction`, and
  `*_total` variants. Unknown columns are ignored, but every classified value is kept in
  `extra.columns` so a misclassification can be audited.
- Check date and pay period come from columns when present, otherwise from title rows
  ("Check Date: 10/30/2026", "Pay Period: 10/12/2026 - 10/25/2026"). `run_id` is a run column if one
  exists, otherwise `<store>-<check date>`.
- `payroll_runs.total_cost = gross_wages + employer_taxes + benefits` (employer-paid benefits).
  `extra` carries `employee_taxes`, `tips`, `salaried_gross`, `hourly_gross`, hours and `net_pay`.
- **Session**: the sign-in is bot-checked, so there is **no `login()`**.
  `modes: ['session', 'inbox', 'drive']`. A session is created by the Chrome handoff
  (`handoffDomains: toasttab.com, payroll.toasttab.com, auth.toasttab.com`). `collect` tries the internal
  JSON first (`ENDPOINTS`, UNVERIFIED until confirmed with `npm run ops:record toast-payroll`). If that
  fails, it walks Past Payrolls > View > Employee Detail > Excel/CSV download (`SELECTORS`, UNVERIFIED)
  and runs the result through `parseFile`. With no page available it rethrows instead of returning empty.

## Feeding prime cost (`dashboard/prime-cost-model.mjs`, `dashboard/prime.mjs`)

Today, labor in prime cost has two parts:
1. **Hourly wages per business day.** These come from the Toast POS labor report (`totalWages`), audited
   against Toast time entries (`auditWages`: reg*rate + OT*rate*1.5, owner pay excluded,
   manager overlap flagged).
2. **Salaries.** These come from `prime-salary-baseline.json`, a hand-entered biweekly figure from one
   verified payroll (Aug 17–30) less owner pay, spread as `salaryBiweekly / 14` per day.

How the new tables connect:
- **Salary baseline -> `payroll_runs`.** For each store and run, `extra.salaried_gross` (minus owner
  lines, using the same owner list as `auditWages`) over a 14-day period replaces the static
  `biweeklyCents`. `period_start`/`period_end`/`pay_date` fill the baseline's
  `periodStart/periodEnd/checkDate`. The baseline then refreshes every payroll instead of being frozen at August.
- **Labor burden.** `employer_taxes + benefits` per run, spread over the period's days (or as a
  % of gross applied to the daily wages), adds the payroll-tax and benefits cost that prime cost leaves out today.
- **Second wage audit.** `labor_shifts` (Homebase) grouped by `store, business_date` gives
  `sum(labor_cost)`, which can be checked against Toast `totalWages` for the same day. Both use the same
  4 AM business-date rule and the same 1.5x OT. `schedule_shifts.scheduled_cost` against actual
  `labor_cost` gives schedule-vs-actual by day.
- **True-up.** After each payroll, `payroll_lines.gross_wages - tips` (hourly, `extra.gross_ex_tips`) for
  the period should match the sum of daily Toast wages. Any gap shows up as a variance instead of
  disappearing silently.

## One-time setup

**Homebase**
1. In Homebase, go to Settings > API (<https://app.joinhomebase.com/settings/api>) and request an API key.
   Wait for Homebase to approve it, then copy the key from the same page.
2. Store it in the vault as `homebase.apiKey`. That is all `api` mode needs. Optional: `homebase.locations`
   (UUIDs or names) to limit locations.
3. Fallback (only if the key is denied): store `username`/`password` for a manager login, and make sure
   Homebase's verification emails reach the ops Gmail label (filter `from:joinhomebase.com`).
   Then run `npm run ops:record homebase` once to confirm `ENDPOINTS`/`SELECTORS`.

**Toast Payroll**
1. Use a login with the HR+ role (required for Reports > Standard and PEPAR).
2. Add `payroll.toasttab.com` to the Chrome handoff task so its storageState covers that origin
   (`auth.toasttab.com` handles sign-in).
3. Run `npm run ops:record toast-payroll` once while signed in, open Past Payrolls > View > Employee
   Detail, and confirm `ENDPOINTS`/`SELECTORS`.
4. File fallback: after each payroll, drop the Employee Detail / Payroll Register export (CSV or Excel)
   into the ops Drive folder, or email it into the ops label. The filename or subject must contain "payroll"
   or "register" and should name the store, unless the file has a Location column.
5. On the first real file, compare `parseFile` output with the report totals. If a tax column
   lands in the wrong bucket, add its header to `MONEY_RULES`.
