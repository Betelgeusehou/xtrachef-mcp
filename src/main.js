#!/usr/bin/env node
// xtraCHEF MCP server — read-only tools over ingested invoice CSV exports.
// xtraCHEF has no public API; data arrives via manual/scheduled CSV downloads
// from the app (Invoices > Download).
//
// Two modes:
//   stdio (default)            local use from Claude Code / Claude Desktop
//   XTRACHEF_MCP_MODE=http     hosted use (Railway etc.): Streamable HTTP MCP at
//                              POST /<secret>/mcp, plus /health and data endpoints.
import http from "http";
import {handleDashboard} from "../dashboard/http.mjs";
import {startDashboardRunner} from "../dashboard/runner.mjs";
import { webcrypto } from "crypto";
// Node 18 does not expose global crypto, which the MCP SDK transport needs.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./store.js";
import * as sync from "./sync.js";

const MODE = process.env.XTRACHEF_MCP_MODE || "stdio";

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

const filterShape = {
  location: z.string().optional().describe("Location name substring, for multi-location accounts"),
  vendor: z.string().optional().describe("Vendor name substring"),
  category: z.string().optional().describe("Line category substring, e.g. 'Liquor'"),
  start_date: z.string().optional().describe("Invoice date >= YYYY-MM-DD"),
  end_date: z.string().optional().describe("Invoice date <= YYYY-MM-DD"),
};

// Build a fresh McpServer with all tools registered. Stateless HTTP mode creates
// one per request; stdio mode creates one for the process.
export function buildServer({ local = true } = {}) {
  const server = new McpServer({ name: "xtrachef-mcp", version: "1.1.0" });

  server.tool("xtrachef_status", "Data coverage: line counts, date ranges, locations, ingested files, nightly sync health (sync.state is 'ALERT' when a night's load failed or no new invoices arrived for 2+ days), and how to refresh the data.", {}, async () => json({ ...store.status(), ...(local ? {} : { sync: sync.health() }) }));

  if (local) {
    server.tool("xtrachef_ingest_downloads",
      "Scan the Downloads folder for new xtraCHEF 'Invoices_*.csv' exports, ingest and archive them. Run after downloading a fresh export from xtraCHEF > Invoices > Download.",
      {}, async () => json(store.ingestDownloads()));

    server.tool("xtrachef_ingest_file",
      "Ingest one xtraCHEF invoice-line CSV export from an explicit file path.",
      { path: z.string().describe("Absolute path to the CSV") },
      async ({ path }) => json(store.ingestFile(path)));
  }

  server.tool("xtrachef_ingest_csv_text",
    "Ingest an xtraCHEF invoice-line CSV export passed as text (works from any surface: paste or read the CSV from Drive/Gmail and pass its contents). Duplicate lines are skipped, so re-ingesting is safe.",
    { csv: z.string().describe("Full CSV text including the header row"), filename: z.string().optional().describe("Source name for the ingest log, e.g. Invoices_2026-09.csv") },
    async ({ csv, filename }) => json(store.ingestText(csv, filename || `pasted_${Date.now()}.csv`)));

  if (!local) {
    server.tool("xtrachef_sync_now",
      "Load the newest xtraCHEF export from the 'xtraCHEF Exports' Google Drive folder right now (same job as the nightly sync). Set force=true to reload a file that was already loaded.",
      { force: z.boolean().optional().describe("Reload even if the newest file was already loaded") },
      async ({ force }) => json({ result: await sync.syncNow({ force: !!force }), sync: sync.health() }));
  }

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

  return server;
}

// ---------------------------------------------------------------------------
async function runStdio() {
  const server = buildServer({ local: true });
  await server.connect(new StdioServerTransport());
  console.error("xtrachef-mcp running (stdio)");
}

async function runHttp() {
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const secret = process.env.XTRACHEF_MCP_SECRET;
  if (!secret || secret.length < 16) {
    console.error("Error: XTRACHEF_MCP_SECRET (min 16 chars) is required in http mode. " +
      "Generate one with: node -e \"console.log(crypto.randomUUID().replaceAll('-',''))\"");
    process.exit(1);
  }
  const port = parseInt(process.env.PORT || process.env.XTRACHEF_MCP_PORT || "3000", 10);
  const MCP_LIMIT = 8 * 1024 * 1024;     // MCP request bodies
  const DATA_LIMIT = 200 * 1024 * 1024;  // CSV ingest / store replace

  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("payload too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  const send = (res, code, obj, headers = {}) => {
    const body = typeof obj === "string" ? obj : JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": typeof obj === "string" ? "text/plain" : "application/json", ...headers });
    res.end(body);
  };
  const rpcErr = (res, code, status, message) => send(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });

  const handleMcp = async (req, res) => {
    let parsed;
    try { const raw = await readBody(req, MCP_LIMIT); parsed = raw ? JSON.parse(raw) : undefined; }
    catch (e) { return rpcErr(res, -32700, 400, `Parse error: ${e.message}`); }
    const server = buildServer({ local: false });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      console.error("[xtrachef-mcp] request error:", e?.message || e);
      if (!res.headersSent) rpcErr(res, -32603, 500, "Internal server error");
    }
  };

  const srv = http.createServer(async (req, res) => {
    if(await handleDashboard(req,res))return;
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const bearerOk = req.headers.authorization === `Bearer ${secret}`;
    const inSecretPath = p.startsWith(`/${secret}/`);
    const route = inSecretPath ? p.slice(secret.length + 1) : p; // strip "/<secret>"
    const authed = inSecretPath || bearerOk;

    try {
      if (req.method === "GET" && p === "/health") {
        return send(res, 200, { status: "ok", total_lines: store.loadStore().lines.length });
      }
      if (route === "/mcp") {
        if (!authed) return rpcErr(res, -32001, 401, "Unauthorized");
        if (req.method !== "POST") return send(res, 405, "Method Not Allowed", { Allow: "POST" });
        return handleMcp(req, res);
      }
      if (!authed) return send(res, 404, "Not found");
      if (route === "/ingest" && req.method === "POST") {
        const name = url.searchParams.get("name") || `upload_${Date.now()}.csv`;
        const text = await readBody(req, DATA_LIMIT);
        return send(res, 200, store.ingestText(text, name));
      }
      if (route === "/store" && req.method === "POST") {
        const text = await readBody(req, DATA_LIMIT);
        return send(res, 200, store.replaceStore(JSON.parse(text)));
      }
      if (route === "/store" && req.method === "GET") {
        return send(res, 200, JSON.stringify(store.loadStore()), { "Content-Disposition": "attachment; filename=lines.json" });
      }
      if (route === "/status" && req.method === "GET") {
        return send(res, 200, { ...store.status(), sync: sync.health() });
      }
      if (route === "/sync" && req.method === "POST") {
        return send(res, 200, await sync.syncNow({ force: url.searchParams.get("force") === "true" }));
      }
      return send(res, 404, "Not found");
    } catch (e) {
      console.error("[xtrachef-mcp] error:", e?.message || e);
      if (!res.headersSent) send(res, 500, { error: e?.message || String(e) });
    }
  });

  srv.listen(port, "0.0.0.0", () => {
    startDashboardRunner();
    sync.startSyncScheduler();
    console.error(`xtrachef-mcp running (http) on :${port}  data dir: ${store.DATA_DIR}`);
    console.error(`  MCP endpoint: POST /<secret>/mcp   health: GET /health`);
  });
}

if (MODE === "http") await runHttp(); else await runStdio();
