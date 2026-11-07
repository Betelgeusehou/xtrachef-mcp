# ops — the back-office connector layer

One place every system Betelgeuse runs on lands its data, whether the vendor
has an API or not. Lives inside the xtrachef-mcp service so it shares the
Railway `/data` volume, the hourly runner, Composio, and the MCP endpoint.

## How data gets in (acquisition modes)

Each vendor adapter supports one or more modes. The runner tries them in the
order the adapter lists them and records which one worked.

| Mode | How it works | When to use it |
|---|---|---|
| `api` | Official API or an existing MCP (Toast MCP). | Whenever a real API exists. |
| `session` | Headless Chromium reuses a logged-in session (cookies/storageState) and calls the portal's internal JSON endpoints from inside the page. | Portals with no API. Fastest and most complete. |
| `login` | Headless login with vault credentials + TOTP / emailed code. Produces a session for `session` mode. | Portals without a bot check on sign-in. |
| `handoff` | Chris's real Chrome (scheduled Claude task) signs in, passes the bot check, and POSTs its storageState to `/ops/handoff`. The server then runs `session` mode until it expires. | Portals whose sign-in is bot-checked (Toast family, DoorDash). |
| `inbox` | Vendor's own scheduled report emails land in a Gmail label; attachments are parsed. | Fallback that a vendor can't block. |
| `drive` | A file dropped in a Drive folder (the existing xtraCHEF pattern). | Exports a scheduled Chrome task downloads. |

## Adapter contract

Every vendor is one file in `ops/vendors/<id>.mjs` exporting a default object:

```js
export default {
  id: 'doordash',                    // unique, kebab-case
  name: 'DoorDash Merchant',
  domain: 'delivery',                // delivery | labor | payroll | sales | invoices | banking
  modes: ['session', 'inbox'],       // acquisition order
  kinds: ['delivery_orders', 'delivery_payouts'],  // record kinds it produces (see below)
  loginUrl: 'https://merchant-portal.doordash.com/', // for login/handoff
  // session/login modes ------------------------------------------------
  async login(ctx) {},               // optional; only if 'login' mode is listed
  async isLoggedIn(ctx) {},          // returns boolean using ctx.page
  async collect(ctx, range) {},      // returns { [kind]: Record[] }; range = {from, through} YYYY-MM-DD
  // inbox/drive modes --------------------------------------------------
  matchFile(meta) {},                // meta = {from, subject, filename, mimeType} -> boolean
  parseFile(buffer, meta) {},        // -> { [kind]: Record[] }
};
```

`ctx` (built by `ops/core/session.mjs`) gives an adapter:

- `ctx.page` — Playwright page on the vendor origin, session already restored
- `ctx.api(url, init)` — `fetch` run *inside the page* (carries cookies, CSRF headers you pass), returns parsed JSON; throws on non-2xx
- `ctx.capture(fn, filter)` — runs `fn` and returns the network responses matching `filter` (used to discover internal endpoints)
- `ctx.creds` — `{username, password, totpSecret, ...}` from the vault for this vendor
- `ctx.totp()` — current 6-digit code from `creds.totpSecret`
- `ctx.waitForEmailCode({from, after, pattern})` — polls the ops Gmail label for an MFA code
- `ctx.store` — canonical store resolver: `ctx.store('Betelgeuse Montrose')` -> `'Montrose'`
- `ctx.log(msg)` — goes to the run log, never contains secrets

Adapters must never log credentials, cookies, or tokens.

## Canonical stores

`Montrose` and `Washington`. Every record carries `store` as one of these.
Map vendor store names in `ops/core/stores.mjs`.

## Record kinds (normalized tables)

All money in dollars (number, 2dp). Dates `YYYY-MM-DD` in America/Chicago
business date. Timestamps ISO-8601. `vendor` = adapter id. Natural key fields
are marked *; upserts replace on the natural key.

- **delivery_orders**: vendor*, store, business_date, order_id*, placed_at, status, subtotal, tax, tip, commission, processing_fee, marketing_fee, adjustments, error_charges, payout, channel
- **delivery_payouts**: vendor*, store, payout_id*, payout_date, period_start, period_end, gross_sales, total_fees, adjustments, net_payout
- **labor_shifts**: vendor*, store, shift_id*, business_date, employee, role, clock_in, clock_out, regular_hours, ot_hours, wage_rate, labor_cost, tips_declared
- **schedule_shifts**: vendor*, store, shift_id*, business_date, employee, role, start, end, scheduled_hours, scheduled_cost
- **payroll_runs**: vendor*, store, run_id*, pay_date, period_start, period_end, gross_wages, employer_taxes, benefits, total_cost, employee_count
- **payroll_lines**: vendor*, run_id*, employee*, store, gross_wages, regular_hours, ot_hours, tips, employer_taxes
- **bank_transactions**: vendor*, account, txn_id*, posted_date, amount, description, category

Anything a vendor gives that doesn't fit goes in `extra` (object) on the record.

## Where things live

```
ops/core/       vault, session (Playwright), totp, store (SQLite), stores, health, runner, registry
ops/vendors/    one adapter per vendor
ops/inbox/      Gmail label ingest (Composio) -> adapter.parseFile
ops/handoff/    /ops/handoff endpoint + the Chrome scheduled-task prompt
ops/tools.mjs   MCP tools (ops_status, ops_query, ops_sync_now, delivery_summary, labor_summary, payroll_summary)
```

## Environment

- `OPS_ENABLED=true` — turn the layer on
- `OPS_VAULT_KEY` — 32-byte base64 key; encrypts `/data/ops/vault.enc` and stored sessions
- `OPS_HANDOFF_TOKEN` — bearer token the Chrome handoff task uses (≥32 chars)
- `OPS_GMAIL_LABEL` — label the vendor report emails are filtered into (default `ops-reports`)
- `OPS_GMAIL_ACCOUNT` — Composio Gmail account id
- `OPS_ALERT_WEBHOOK` — POSTed on failures (falls back to `XTRACHEF_ALERT_WEBHOOK`)
- `OPS_SYNC_HOURS` — Chicago hours to run collectors (default `4,5,6,14`)
- `OPS_DATA_DIR` — default `${XTRACHEF_DATA_DIR || /data}/ops`
