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
- **Natural keys are the same on every path.** The store upserts on these keys, so the same shift or
  payroll collected via API/session and again from an inbox/drive file must produce the same key or it
  is stored twice. Vendor ids never go into a key; they are kept in `extra`.

  | Kind | Key | Vendor id kept in |
  |---|---|---|
  | `labor_shifts.shift_id` | `<store>\|<employeeKey>\|<clock_in UTC minute>` e.g. `Montrose\|id:1001\|2026-10-23T23:00Z` | `extra.homebase_timecard_id` |
  | `schedule_shifts.shift_id` | `<store>\|<name key>\|<start UTC minute>\|<role lowercase>` | `extra.homebase_shift_id` |
  | `payroll_runs.run_id`, `payroll_lines.run_id` | `<store>\|<check date>\|<period start>\|<period end>` | `extra.toast_run_id` |
  | `payroll_lines.employee` | `<Name> #<employee id>` when an id/number exists, else `<Name>` | `extra.employee_name`, `extra.employee_id` |

  `employeeKey` for labor shifts is `id:<payroll id>` when the source has one (API timecards, the
  Timesheets export's Payroll ID column) and the lowercased, trimmed full name otherwise. Schedule
  shifts key on the name only, because the API Shift entity has no documented payroll id. Names are
  normalized to "First Last" ("Ruiz, Ana" becomes "Ana Ruiz") before keying. If a source drops the
  payroll id that another source for the same shift had, the two keys differ; keep the Payroll ID
  column in the Timesheets export.
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

- **Open shifts.** Unassigned / OPEN schedule shifts (API `open: true`, or no employee in the export)
  are not stored in `schedule_shifts`, so scheduled hours and cost are not inflated by shifts nobody
  works. The count is in the result's non-enumerable `stats.open_shifts_skipped`.
- **Partial workweeks.** When a Timesheets export has no OT columns, OT is computed from that file
  alone. A workweek the file does not cover end to end (the week starts before the file's first
  business date or ends after its last) may be missing hours from another file, so its regular/OT
  split can be understated. Those rows get `extra.ot_partial_week = true` (full weeks get `false`;
  `stats.ot_partial_week_rows` counts them). Export whole Monday-Sunday weeks, or treat flagged rows'
  OT as provisional until the payroll true-up.

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
  ("Check Date: 10/30/2026", "Pay Period: 10/12/2026 - 10/25/2026"). `run_id` is always
  `<store>|<check date>|<period start>|<period end>` (see the key table above); a run column, or the
  session's Toast payroll id, goes to `extra.toast_run_id`.
- `payroll_runs.total_cost = gross_wages + employer_taxes + benefits` (employer-paid benefits).
  `extra` carries `employee_taxes`, `tips`, `wages_ex_tips`, `salaried_gross`, `hourly_gross`, hours and
  `net_pay`.
- **Tips vs wages.** `gross_wages` includes tips paid through payroll. Every `payroll_runs` record has
  `extra.tips` and `extra.wages_ex_tips = gross_wages - tips`; labor-cost consumers read
  `wages_ex_tips`. Each `payroll_lines` record sets the `tips` column and `extra.gross_ex_tips`.
- **Same-name employees.** When the export has an employee id/number column (or the session JSON an
  employee number/id), `payroll_lines.employee` is `Name #id` so two people with the same name are
  separate lines.
- **XLSX safety.** The built-in ZIP reader refuses entries declaring more than 50 MB uncompressed and
  caps inflation at the declared size, so a crafted file cannot exhaust memory.
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
