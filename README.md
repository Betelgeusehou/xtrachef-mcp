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

- `data/lines.json` — normalized line items, deduped by
  (location, vendor, invoice #, item code, description, qty, unit price, line total)
- `data/raw/` — archived source CSVs

The `data/` directory is gitignored: your invoice data stays local.

## License

MIT
