#!/usr/bin/env node
// xtraCHEF MCP server — read-only tools over locally ingested invoice CSV exports.
// xtraCHEF has no public API; data arrives via manual/scheduled CSV downloads
// from the app (Invoices > Download), ingested with xtrachef_ingest_downloads.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./store.js";

const server = new McpServer({ name: "xtrachef-mcp", version: "1.0.0" });

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

const filterShape = {
  location: z.string().optional().describe("Location name substring, for multi-location accounts"),
  vendor: z.string().optional().describe("Vendor name substring"),
  category: z.string().optional().describe("Line category substring, e.g. 'Liquor'"),
  start_date: z.string().optional().describe("Invoice date >= YYYY-MM-DD"),
  end_date: z.string().optional().describe("Invoice date <= YYYY-MM-DD"),
};

server.tool("xtrachef_status", "Data coverage: line counts, date ranges, locations, ingested files, and how to refresh the data.", {}, async () => json(store.status()));

server.tool("xtrachef_ingest_downloads",
  "Scan the Downloads folder for new xtraCHEF 'Invoices_*.csv' exports, ingest and archive them. Run after downloading a fresh export from xtraCHEF > Invoices > Download.",
  {}, async () => json(store.ingestDownloads()));

server.tool("xtrachef_ingest_file",
  "Ingest one xtraCHEF invoice-line CSV export from an explicit file path.",
  { path: z.string().describe("Absolute path to the CSV") },
  async ({ path }) => json(store.ingestFile(path)));

server.tool("xtrachef_list_invoices",
  "List invoices (header level) matching filters, newest first.",
  { ...filterShape, invoice_number: z.string().optional(), limit: z.number().optional() },
  async ({ limit, ...f }) => json(store.listInvoices(f, limit ?? 100)));

server.tool("xtrachef_get_line_items",
  "Invoice line items matching filters, newest first. 'item' matches description substring or exact item code.",
  { ...filterShape, item: z.string().optional(), invoice_number: z.string().optional().describe("Exact invoice number to fetch all lines of one invoice"), limit: z.number().optional() },
  async ({ limit, ...f }) => json(store.queryLines(f, limit ?? 200)));

server.tool("xtrachef_price_history",
  "Unit-price series over time for an item (description substring or item code), oldest first.",
  { item: z.string(), ...filterShape },
  async ({ item, ...f }) => json(store.priceHistory(item, f)));

server.tool("xtrachef_price_changes",
  "Items whose unit price moved at least min_pct between the first and last purchase in range, biggest movers first.",
  { min_pct: z.number().optional().describe("Minimum absolute % change, default 5"), ...filterShape },
  async (args) => json(store.priceChanges(args)));

server.tool("xtrachef_spend_summary",
  "Total spend grouped by vendor, category, gl, or location, over the filtered range.",
  { group_by: z.enum(["vendor", "category", "gl", "location"]).optional(), ...filterShape },
  async (args) => json(store.spendSummary(args)));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("xtrachef-mcp running (stdio)");
