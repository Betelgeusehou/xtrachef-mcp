# Delivery adapters: DoorDash, Uber Eats, Grubhub

Files: `doordash.mjs`, `ubereats.mjs`, `grubhub.mjs`, shared helpers in
`_delivery-common.mjs`, tests in `delivery.test.mjs` (`node --test ops/vendors/delivery.test.mjs`),
synthetic fixtures in `fixtures/delivery/`.

All three adapters export the README contract plus `handoffDomains`, list
`modes: ['session', 'inbox', 'drive']`, and produce `delivery_orders` and
`delivery_payouts`. None ships a `login()` (reasons per vendor below).

## How parsing works (all vendors)

- **Header-driven.** Headers are normalized (lowercase, punctuation and spaces
  stripped, `%` -> `pct`), so `DoorDash order ID`, `doordash_order_id` and
  `doordashOrderId` are the same key. Each field has an alias list. Column order
  is never used. Title rows above the header and Uber's description row under it
  are skipped. UTF-8 BOM and UTF-16 files are handled.
- **One mapper per vendor for CSV and JSON.** `mapOrderRow` / `mapPayoutRow` take
  either a CSV row or a JSON item from a portal endpoint. JSON money objects
  (`{unit_amount, currency}`, `{amountE5}`, `{units, nanos}`, `{amount_cents}`) are
  converted to dollars.
- **Money.** `$1,234.56`, `(12.00)`, `-12.00`, `-$3.00`, `$-3.00`, `12.50-` all parse; blanks and `N/A` are null.
- **Business date.** Local wall time in America/Chicago. An order placed before
  **04:00** belongs to the previous business date (bar closes at 2am). When a
  source only gives UTC, it is converted to Chicago time first (CST/CDT aware).
  `placed_at` is the UTC ISO instant.
- **Store mapping.** `canonicalStore(label)` from `ops/core/stores.mjs`. Rows whose
  store does not map are skipped and counted (`stats.skipped_store`,
  `stats.unmapped_stores`). Endless Bummer maps to Montrose.
- **Several rows per order** (DoorDash `ERROR_CHARGE`/`ADJUSTMENT` rows, Grubhub
  adjustment rows) are summed into the one order record; `extra.row_types` lists them.
- **Sign conventions on output.** `commission`, `processing_fee`, `error_charges`
  are positive costs. `marketing_fee` is the restaurant's net marketing cost
  (fees + restaurant-funded discounts - platform credits). `adjustments` and
  `payout` are signed (+ = money to the restaurant). `tax` is tax the restaurant
  actually receives (Texas is a marketplace-facilitator state, so this is
  usually ~0; the collected tax is kept in `extra`).
- **Reconciliation check.** For every order:
  `payout = subtotal + tax + tip - commission - processing_fee - marketing_fee - error_charges + adjustments`
  within $0.01; for every payout `net_payout = gross_sales - total_fees + adjustments`.
  A mismatch is not dropped, it gets a string in `extra.warnings`.
- **Result stats.** `parseFile` / `collect` return `{delivery_orders, delivery_payouts}`
  with a non-enumerable `stats` property (`rows, orders, payouts, skipped_store,
  skipped_other, unmapped_stores, warnings, report, non_order_rows, fallback`).
- **IDs.** Raw vendor IDs (the store key is already `vendor + order_id`).
  Uber Eats uses the **Workflow ID** (unique UUID); the short tablet Order ID is
  kept in `extra.display_order_id`.
- **Same `order_id` on every path.** Session JSON and CSV files go through the
  same `mapOrderRow` and alias list per vendor, so an order collected both ways
  upserts onto one row (checked 2026-11-07, covered by tests):
  - DoorDash: `doordash_order_id` (JSON `doordash_order_id`/`doordashOrderId`, CSV "DoorDash order ID").
  - Uber Eats: Workflow ID (JSON `workflowId`, CSV "Workflow ID"). A JSON item
    without a workflow ID throws `shape changed` instead of falling back to the
    short display ID, which would key the order differently from the file.
  - Grubhub: order number (JSON `order_number`, CSV "Order Number").
  `payout_id` is the vendor's payout/deposit id on both paths as well.

### Session mode

`collect(ctx, range)` calls the `ENDPOINTS` in each file through `ctx.api`,
paginates (cursor or page), splits the range into windows, validates each
response and item, and maps with the same normalizer as the CSV path. Any shape
mismatch throws `endpoint shape changed: <what is missing>` (with
`err.shapeChanged = true`). Before giving up, `collect` drives the portal UI per
`SELECTORS` to generate and download the CSV report (`page.waitForEvent('download')`)
and runs `parseFile` on it (`stats.fallback = 'ui_download'`). If both fail the
error is rethrown so the runner falls back to inbox mode.

**No vendor's internal portal endpoints are publicly documented.** Every
`ENDPOINTS` and `SELECTORS` block is marked
`// UNVERIFIED until confirmed with: npm run ops:record <vendor>`. Until then,
session mode will most likely throw "shape changed" and fall through to the UI
download and then inbox. Inbox/drive parsing does not depend on any of this.

### Known caveat: derived payouts

Uber Eats payment details and Grubhub transactions carry a payout/deposit ID on
each order row, so those parsers also emit `delivery_payouts` built from the
rows (`extra.derived_from_orders: true`). A file covering part of a payout
period gives a partial payout. The store upserts on `payout_id`, so whichever
file lands last wins: schedule the real payout/deposit report to arrive after
the order-level one, or filter on `extra.derived_from_orders` when it matters.
Every derived payout carries `extra.derived_from_orders: true`, including one
merged with a real payout row of the same id in the same result; the tools layer
excludes these from payout reconciliation.

---

## DoorDash (`doordash`)

- `loginUrl`: https://merchant-portal.doordash.com/
- `handoffDomains`: `['doordash.com']`
- **No `login()`.** Sign-in goes through identity.doordash.com with bot checks; sessions come from the Chrome handoff.

**Source of truth for columns:** DoorDash publishes the schema of its Merchant
reports for the Reporting API, and the Merchant Portal financial exports carry
the same fields (as title-case headers):
- https://developer.doordash.com/docs/reporting/overview/reports/marketplace_merchant_pick (TRANSACTION_DETAIL v4, PAYOUT_SUMMARY v3+, ORDER_DETAIL)
- https://developer.doordash.com/docs/reporting/overview/available_reports
- https://merchants.doordash.com/en-us/learning-center/payout-and-monthly-statement (portal report names: Transactions overview, Transactions breakdown, Payouts; field labels; reports emailed when ready, kept 7 days; recurring reports available)
- https://loop.helpwise.help/articles/235346 and https://loop.helpwise.help/articles/235364-how-to-generate-your-doordash-payouts-reports (click path)
- https://loop.helpwise.help/articles/235347 (Subtotal, Tax Subtotal, Commission, Marketing Fees, Tips, Error Charges, Adjustments)

Exact header capitalization in the portal CSV is **ASSUMED** (the normalizer makes it irrelevant).

### Transactions breakdown (TRANSACTION_DETAIL) -> delivery_orders

| Field | Column(s) | Status |
|---|---|---|
| order_id | `doordash_order_id` (DoorDash order ID) | VERIFIED |
| store | `store_name` | VERIFIED |
| placed_at / business_date | `timestamp_local_date` + `timestamp_local_time` (fallback `timestamp_utc_date` + `timestamp_utc_time`) | VERIFIED |
| status | `final_order_status` (else `transaction_type`) | VERIFIED |
| row type | `transaction_type` (DELIVERY, ERROR_CHARGE, ADJUSTMENT, AD_FEE, ...) | VERIFIED |
| subtotal | `subtotal` | VERIFIED |
| tax | `subtotal_tax_passed_to_merchant`; else `tax_subtotal` minus `subtotal_tax_remitted_by_doordash_to_tax_authorities` | `tax_subtotal`, `..._remitted_...` VERIFIED; the plain `subtotal_tax_passed_to_merchant` header ASSUMED (published schema only has the federal/provincial variants) |
| tip | `staff_tip` (courier tips are not the merchant's) | VERIFIED |
| commission | `commission` + `commission_tax` | VERIFIED |
| processing_fee | `payment_processing_fee` / `merchant_fees` + `tablet_fee`, `printer_fee`, `alcohol_flat_fee`, `flexible_fulfillment_flat_fee` (+ their taxes) | fee columns VERIFIED; `payment_processing_fee` ASSUMED (portal label "Payment processing fee") |
| marketing_fee | `marketing_fees_including_any_applicable_taxes` + `customer_discounts_from_marketing_funded_by_you` - `doordash_marketing_credit` - `third_party_contribution` | VERIFIED |
| error_charges | `error_charges` | VERIFIED |
| adjustments | `adjustments` | VERIFIED |
| payout | `net_total` (Net total); else `credit - debit` | `credit`/`debit` VERIFIED; `Net total` VERIFIED as a portal field name, as a column ASSUMED |
| extra | `payout_id`, `payout_date`, `transaction_id`, `store_id`, `description` | VERIFIED |

Rows with no order id (AD_FEE, store-level adjustments) are counted in
`stats.non_order_rows` and not turned into orders.

### Payouts (PAYOUT_SUMMARY) -> delivery_payouts

| Field | Column(s) | Status |
|---|---|---|
| payout_id | `payout_id` | VERIFIED |
| payout_date | `payout_date` | VERIFIED |
| period_start / period_end | `transaction_start_local_date` / `transaction_end_local_date` | VERIFIED |
| gross_sales | `subtotal` + merchant tax + `staff_tip` | VERIFIED |
| total_fees | commission (+tax) + processing/tablet/etc fees + net marketing | VERIFIED |
| adjustments | `adjustments` - `error_charges` | VERIFIED |
| net_payout | `net_payout` | VERIFIED |
| extra | `payout_status`, `total_before_adjustments` | VERIFIED |

The item-level **Order Details** report (ORDER_DETAIL, has `dd_order_number`) is
recognized and ignored (no fees in it).

### Session endpoints (all UNVERIFIED)

`/merchant-portal-api/v1/stores`, `/merchant-portal-api/v1/financials/transactions`
(cursor), `/merchant-portal-api/v1/financials/payouts` (offset) on
merchant-portal.doordash.com. Placeholders; no public source. UI fallback:
Reports > Create report > Financials > Transactions breakdown / Payouts.

### What Chris does once (DoorDash)

1. Merchant Portal > Reports > Create report > Financials > **Transactions breakdown**, both stores, set it to **recurring** (weekly, or daily if offered). Repeat for **Payouts**.
2. DoorDash emails a "report ready" notice from doordash.com. If the email carries the CSV, a Gmail filter (from `doordash.com`) into the `ops-reports` label is enough. If it only links to the portal (the help center says the file sits in Reports for 7 days), inbox mode can't fetch it; the Chrome handoff task downloads it into the Drive folder instead.
3. Run the Chrome handoff once so session mode has cookies, then `npm run ops:record doordash`, click through Financials, and paste the captured endpoint paths and response paths into `ENDPOINTS` (and fix `SELECTORS`).
4. Add any store-name spelling DoorDash uses that `canonicalStore` misses (watch `stats.unmapped_stores`).

---

## Uber Eats (`ubereats`)

- `loginUrl`: https://merchants.ubereats.com/manager
- `handoffDomains`: `['uber.com', 'ubereats.com']`
- **No `login()`.** Sign-in runs through auth.uber.com: email, then an SMS code, with password as a fallback ("I didn't receive the code"), plus Uber's risk checks. Not a plain username/password form. Source: https://merchants.ubereats.com/mx/en/resources/learning-center/log-in/

**Sources:**
- https://help.uber.com/merchants-and-restaurants/article/reviewing-payment-details-report?nodeId=081e858d-6b68-411b-bfbb-b5e86d2f8cff (full US column list with definitions)
- https://www.uber.com/au/en/blog/changes-to-merchant-payment-reports-2023/ (Refund (excl. tax) / Tax on Refund / Refund (incl. tax) columns, Payout Summary report exists)
- https://loop.helpwise.help/articles/235348 (Sales (excl. tax), Tax_on_sales, Marketplace Fee, Marketplace facilitator tax, Total payout, ...)
- https://loop.helpwise.help/articles/235350-how-to-generate-payment-details-report-in-ubereats (Reports > Create report > Payment details)
- https://developer.uber.com/docs/eats/references/api/v1/post-eats-report (official Reporting API: report types incl. Payment Details, 32-day max range; needs a partner OAuth app, not usable by an operator)
- https://developer.uber.com/docs/eats/guides/reporting (parse by header, not column order)

### Payment details -> delivery_orders (+ derived delivery_payouts)

US column list is VERIFIED from Uber's help article. Help uses "excluding/including"; exports have been seen as "excl./incl." — both are aliases.

| Field | Column(s) | Status |
|---|---|---|
| order_id | `Workflow ID` (unique); `Order ID` kept as `extra.display_order_id` | VERIFIED |
| store | `Store Name` | VERIFIED |
| placed_at / business_date | `Order Date` + `Order Accept Time` (local) | VERIFIED |
| status | `Order Status` (Completed, Canceled, Refund, Unfulfilled) | VERIFIED |
| channel | `Dining Mode` / `Order Channel` | VERIFIED |
| subtotal | `Sales (excl. tax)` | VERIFIED |
| tax | `Tax on Sales` + `Marketplace Facilitator Tax` (negative; Uber remits) | VERIFIED |
| tip | `Tips` | VERIFIED |
| commission | -`Marketplace fee` | VERIFIED |
| processing_fee | -(`Delivery Network Fee` + `Order Processing Fee`) | VERIFIED |
| marketing_fee | -(`Promotions on items` + tax + `Promotions on delivery` + tax + `Marketing adjustment`) | VERIFIED |
| error_charges | refunds: `Refund (incl. tax)` (or excl. + `Tax on Refund`) when negative | VERIFIED (2023 blog) |
| adjustments | `Price Adjustments (excl. tax)` + tax + `Bag Fee` + `Merchant Fee` + tax + `Other payments` + `Backup Withholding Tax` + `Markup Amount` + `Markup Tax` | VERIFIED |
| payout | `Total payout` | VERIFIED |
| payout link | `Payout reference ID`, `Payout Date` | VERIFIED |

Rows without an order (ad spend, credits under `Other payments`) are counted in
`stats.non_order_rows` and added to the derived payout's adjustments so
derived payouts reconcile to the deposit.

### Payout summary -> delivery_payouts

Report existence VERIFIED (2023 blog). Columns are **ASSUMED**: `Payout reference ID`,
`Payout Date`, `Payout Period Start/End`, `Number of Orders`, plus the same money
columns as Payment details and `Total payout`. Detection needs `Payout reference ID` + `Total payout`
and no `Workflow ID`/`Order ID`.

### Session endpoints (all UNVERIFIED)

POST `/manager/api/getStores`, `/manager/api/getPaymentDetails` (cursor, 31-day
windows), `/manager/api/getPayouts` on merchants.ubereats.com with `x-csrf-token: x`.
Placeholders; no public source. UI fallback: Reports > Create report > Payment details.

### What Chris does once (Uber Eats)

1. Uber Eats Manager > Reports > Create report > **Payment details**, both stores. If Manager offers a schedule, set weekly (Monday, covering the prior payout week). Also schedule **Payout summary** if available.
2. Gmail filter: from `uber.com` with a .csv attachment -> `ops-reports`. If the email only links to Manager, the Chrome handoff task downloads it to Drive instead.
3. Chrome handoff once, then `npm run ops:record ubereats`, open Payments and Reports, and paste the captured endpoints into `ENDPOINTS`.
4. Make sure store names in Manager contain "Montrose" / "Washington" (or add a pattern to `ops/core/stores.mjs`).

---

## Grubhub (`grubhub`)

- `loginUrl`: https://restaurant.grubhub.com/login (URL from https://help.bench.co/third-party-login-instructions/grubhub)
- `handoffDomains`: `['grubhub.com']`
- **No `login()`, unsure.** The portal sign-in is an email + password form and admins can add users (https://support.itsacheckmate.com/hc/en-us/articles/26105038362139-Creating-a-Grubhub-Login-for-Reconcile), but no source says whether there's a bot check or an emailed code step. If `ops:record grubhub` shows a plain form with at most an emailed code, add a `login()` that fills email/password and uses `ctx.waitForEmailCode({from: 'grubhub.com'})`, and add `'login'` to `modes`.

**Sources.** Grubhub publishes no export column spec, and its help center
blocked fetching. What is verified is the set of fee categories, from
reconciliation vendors' glossaries:
- https://support.lunchbox.io/en/articles/16738255-financial-reconciliation-glossary (Commission, Delivery Commission (Grubhub Delivery), Delivery Fee (Self Delivery), Error Charges, Marketing Fee, Net Payout, Other Payments, Payment Transaction Fee, Promo Value, Tax Remitted To Merchant, Tips)
- https://invoicedataextraction.com/blog/reconcile-doordash-uber-eats-grubhub-payouts-restaurant (Marketing commission, Delivery commission, Processing fees, Refunds and adjustments, Marketplace facilitator tax, Tips, Net payout)
- https://jentic.com/apis/grubhub (host `api-gtm.grubhub.com`, `/restaurants/{id}/reports/financials`, `/reports/orders`; third-party catalog, not official)

### Transactions -> delivery_orders (+ derived delivery_payouts)

All header spellings **ASSUMED**; aliases cover the likely variants.

| Field | Aliases tried | Status |
|---|---|---|
| order_id | Order Number, Order #, Order ID | ASSUMED |
| store | Restaurant, Restaurant Name, Location | ASSUMED |
| date / time | Order Date + Order Time, Transaction Date/Time; JSON `time_placed` (UTC) | ASSUMED |
| row type | Transaction Type (Prepaid Order, Adjustment, Error Charge, Cancellation) | ASSUMED |
| subtotal | Subtotal, Food Subtotal | ASSUMED |
| tax | Sales Tax minus Withheld Tax / Marketplace Facilitator Tax | category VERIFIED, headers ASSUMED |
| tip | Tip, Tips | category VERIFIED |
| commission | Commission / Marketing Commission + Delivery Commission | category VERIFIED |
| processing_fee | Processing Fee, Payment Transaction Fee | category VERIFIED |
| marketing_fee | Promotion, Promo Value, Restaurant Funded Promotion, Loyalty | category VERIFIED |
| error_charges | Error Charges, or an Adjustment amount on an `Error Charge` row | category VERIFIED |
| adjustments | Adjustment(s), Refund, Other Payments, self-delivery fee | category VERIFIED |
| payout | Restaurant Total, Net Payout, Net Total | category VERIFIED |
| payout link | Deposit ID / Payout ID, Deposit Date | ASSUMED |

A trailing `Total` row is skipped. Files carrying DoorDash/Uber signature columns are refused.

### Deposits -> delivery_payouts

Columns **ASSUMED**: Deposit ID, Deposit Date, Period Start/End, Gross Sales, Total Fees, Adjustments, Deposit Amount.

### Session endpoints (all UNVERIFIED)

`https://api-gtm.grubhub.com/merchant/v1/restaurants`,
`.../restaurants/{id}/reports/financials/transactions`, `.../deposits` (page
pagination, bearer token read from the portal page's storage). UI fallback:
restaurant.grubhub.com/financials/transactions > date range > Download.

### What Chris does once (Grubhub)

1. Download one **Transactions** CSV from Grubhub for Restaurants > Financials for last week and drop it in the Drive folder (or send it to the ops inbox). Check `stats` from the run: if `report` is null or orders are 0, send the header row to Claude and the alias lists get the real names. This is the first thing to do for Grubhub, since nothing about its file is verified.
2. If the portal can email statements/transactions on a schedule, turn it on and add a Gmail filter from `grubhub.com` -> `ops-reports`.
3. Chrome handoff once, `npm run ops:record grubhub`, confirm whether sign-in is a plain form (see login note) and paste the real endpoints.

---

## Summary: verified vs assumed

| | Order-level columns | Payout columns | Internal endpoints | UI selectors | login() |
|---|---|---|---|---|---|
| DoorDash | VERIFIED (published report schema) | VERIFIED | UNVERIFIED | UNVERIFIED (click path verified from docs) | none (bot-checked) |
| Uber Eats | VERIFIED (Uber help article) | ASSUMED (report exists) | UNVERIFIED | UNVERIFIED (click path verified from docs) | none (SMS-code auth.uber.com) |
| Grubhub | categories VERIFIED, headers ASSUMED | ASSUMED | UNVERIFIED (host from 3rd-party catalog) | UNVERIFIED | none yet (unknown) |
