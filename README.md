# xtrachef-mcp

A local MCP server that gives Claude (or any MCP client) queryable access to your
[xtraCHEF by Toast](https://pos.toasttab.com/products/xtrachef) invoice data —
price history, price-change alerts, spend summaries, and line-item search.

**Why this exists:** xtraCHEF has no public API. The only way to get your invoice
line-item data out is the CSV export in the web app. This server ingests those
exports into a local, deduplicated store and exposes query tools over it. Your
data never leaves your machine.

Built by a restaurant operator (two locations on Toast + xtraCHEF) to answer
questions like "what's the price history on chicken wings," "which items went up
more than 10% this quarter," and "what did we spend with each vendor last month."

**New to this kind of tool?** See the [step-by-step walkthrough](WALKTHROUGH.md) —
no coding experience needed.

## Setup

Requires [Node.js](https://nodejs.org) 18+.

```bash
git clone https://github.com/Betelgeusehou/xtrachef-mcp.git
cd xtrachef-mcp
npm install
```

Register it with your MCP client. For Claude Code / Claude Desktop, add to your
`.mcp.json` (or run `claude mcp add`):

```json
{
  "mcpServers": {
    "xtrachef": {
      "command": "node",
      "args": ["/absolute/path/to/xtrachef-mcp/src/main.js"]
    }
  }
}
```

## Getting your data in (refresh procedure)

1. Log in at app.xtrachef.com.
2. Left nav → **Invoices** (under Invoice Automation).
3. Set the upload-date range filter to cover everything since your last ingest
   (overlap is fine — ingestion dedupes).
4. Click **Download** (top right of the table). A file named
   `Invoices_<YourBusiness>_<date>.csv` lands in your Downloads folder.
5. Ask Claude to run `xtrachef_ingest_downloads`. New files are ingested and
   archived to `data/raw/`; already-ingested filenames are skipped.

> Note: the Excel button on **Search invoices** exports invoice *headers* only.
> The **Invoices** page Download is the line-item export you want.

Repeat on whatever cadence you like — weekly works well. Each ingest only adds
lines it hasn't seen before, so overlapping date ranges are harmless.

## Hosting it (Railway, or any Node host)

The server also runs as a remote MCP over Streamable HTTP, so claude.ai, the Claude
mobile app, Claude Code on the web, and cloud routines can all use it without a local
machine. This mirrors how [toast-mcp](https://github.com/Betelgeusehou/toast-mcp-2026-complete) is hosted.

1. Deploy this repo as a Railway service (GitHub source) and attach a **volume** mounted
   at `/data` so ingested invoices persist across deploys.
2. Set variables:
   - `XTRACHEF_MCP_MODE=http`
   - `XTRACHEF_MCP_SECRET=<long random string>` (generate one:
     `node -e "console.log(crypto.randomUUID().replaceAll('-',''))"`)
   - `XTRACHEF_DATA_DIR=/data`
   - `PORT=3000` (Railway sets this automatically; set the domain's target port to 3000)
3. Generate a domain and confirm `https://<domain>/health` returns `{"status":"ok",...}`.
4. Add it in claude.ai: Settings → Connectors → Add custom connector, URL
   `https://<domain>/<secret>/mcp`. The secret in the URL is the only lock on your
   invoice data; treat the URL like a password and rotate the variable if it leaks.

Endpoints (all under `/<secret>/`, or send `Authorization: Bearer <secret>` instead):

| Method | Path | Purpose |
|---|---|---|
| POST | `/mcp` | MCP endpoint (Streamable HTTP, stateless) |
| POST | `/ingest?name=Invoices_x.csv` | Ingest a CSV export sent as the request body |
| POST | `/store` | Replace the whole store with a `lines.json` (seed from a local copy) |
| GET | `/store` | Download the store as `lines.json` |
| GET | `/status` | Same as the `xtrachef_status` tool |
| GET | `/health` | Unauthenticated health check |

Seed a fresh hosted instance from a local store:

```bash
curl -X POST --data-binary @data/lines.json https://<domain>/<secret>/store
```

Refresh from anywhere: download the CSV from xtraCHEF, then either `curl -X POST
--data-binary @Invoices_x.csv "https://<domain>/<secret>/ingest?name=Invoices_x.csv"`
or hand the CSV text to the `xtrachef_ingest_csv_text` tool from any Claude surface.
In http mode the two local-filesystem tools (`ingest_downloads`, `ingest_file`) are not
registered, since the server has no Downloads folder.

## Tools

| Tool | What it does |
|---|---|
| `xtrachef_status` | Data coverage, date ranges, ingested files, refresh how-to |
| `xtrachef_ingest_downloads` | Scan Downloads for new `Invoices_*.csv` exports and ingest them |
| `xtrachef_ingest_file` | Ingest one CSV from an explicit path |
| `xtrachef_list_invoices` | Header-level invoice list with filters |
| `xtrachef_get_line_items` | Line-item query (item / vendor / location / category / dates) |
| `xtrachef_price_history` | Unit-price series over time for one item |
| `xtrachef_price_changes` | Biggest unit-price movers over a range (default ≥5%) |
| `xtrachef_spend_summary` | Spend grouped by vendor, category, GL code, or location |

## Storage

Set `XTRACHEF_DATA_DIR` to move the data directory (hosted deployments use a mounted volume).

- `data/lines.json` — normalized line items, deduped by
  (location, vendor, invoice #, item code, description, qty, unit price, line total)
- `data/raw/` — archived source CSVs

The `data/` directory is gitignored: your invoice data stays local.

## License

MIT
