// Nightly cloud sync: pick up the newest xtraCHEF invoice export from a Google Drive
// folder (via Composio) and load it into both stores:
//   1. the MCP store (lines.json, what the xtrachef_* tools query)
//   2. the dashboard store (/data/dashboard/invoices, what Betelgeuse Live prime cost reads)
// Each invoice in the export replaces that invoice's old lines as a whole, so re-runs
// never double count and corrected invoices overwrite stale copies.
//
// How files reach Drive: a nightly scheduled Claude task clicks Download in xtraCHEF
// (in Chrome, where the session is already signed in) and drops the CSV into the
// "xtraCHEF Exports" Drive folder. Toast's sign-in sits behind a bot check, so the
// server never logs into xtraCHEF itself.
//
// Required env:  COMPOSIO_CONSUMER_API_KEY, XTRACHEF_SYNC_ENABLED=true
// Optional env:  XTRACHEF_DRIVE_FOLDER_ID (default: the "xtraCHEF Exports" folder)
//                XTRACHEF_DRIVE_ACCOUNT (Composio Google Drive account id)
//                XTRACHEF_SYNC_HOURS (Chicago local hours to check, default "3,4,5,6")
//                XTRACHEF_STALE_DAYS (alert when no new uploads for this many days, default 2)
//                XTRACHEF_ALERT_WEBHOOK (POSTed on failure/stale, e.g. an ntfy.sh topic URL)
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as store from "./store.js";

const STATUS_FILE = () => path.join(store.DATA_DIR, "sync-status.json");
const TZ = "America/Chicago";
const FILE_RE = /^Invoices_.*\.csv$/i;

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const FOLDER_ID = () => env("XTRACHEF_DRIVE_FOLDER_ID", "1M8I-8eW8GdlurugKw__giiT7QTfQ_IwF");
const DRIVE_ACCOUNT = () => env("XTRACHEF_DRIVE_ACCOUNT", "googledrive_peba-touch");

export function localDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function localHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(d));
}
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);

export function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE(), "utf8")); } catch { return null; }
}
function writeStatus(s) {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  fs.writeFileSync(STATUS_FILE() + ".tmp", JSON.stringify(s, null, 2));
  fs.renameSync(STATUS_FILE() + ".tmp", STATUS_FILE());
}

// Health summary shown in xtrachef_status and used for alerts.
export function health(now = new Date()) {
  const s = readStatus();
  const enabled = env("XTRACHEF_SYNC_ENABLED", "") === "true";
  const newest = store.newestDates();
  const staleDays = Number(env("XTRACHEF_STALE_DAYS", "2"));
  const gap = newest.upload_date ? daysBetween(newest.upload_date, localDate(now)) : null;
  const problems = [];
  if (!enabled) problems.push("Nightly sync is off (XTRACHEF_SYNC_ENABLED is not true).");
  if (s && s.ok === false) problems.push(`Last sync failed ${s.lastAttemptAt}: ${s.error}`);
  if (s?.lastSuccessAt && now.getTime() - Date.parse(s.lastSuccessAt) > 36 * 3600000)
    problems.push(`No successful sync since ${s.lastSuccessAt}.`);
  if (gap !== null && gap >= staleDays)
    problems.push(`No new invoices uploaded to xtraCHEF in ${gap} days (newest upload ${newest.upload_date}).`);
  return {
    state: problems.length ? "ALERT" : "ok",
    problems,
    enabled,
    newest_upload_date: newest.upload_date,
    newest_invoice_date: newest.invoice_date,
    last_attempt_at: s?.lastAttemptAt ?? null,
    last_success_at: s?.lastSuccessAt ?? null,
    last_file: s?.lastFile ?? null,
    last_result: s?.last ?? null,
    consecutive_failures: s?.consecutiveFailures ?? 0,
    source: `Google Drive folder ${FOLDER_ID()} (newest Invoices_*.csv)`,
    schedule: `checks at ${env("XTRACHEF_SYNC_HOURS", "3,4,5,6")}:00 ${TZ} until the night's file is loaded`,
  };
}

async function alert(h) {
  const url = env("XTRACHEF_ALERT_WEBHOOK", "");
  if (!url || h.state === "ok") return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain", Title: "xtraCHEF sync alert", Priority: "high" }, body: h.problems.join("\n") });
  } catch (e) { console.error("[xtrachef-sync] alert webhook failed:", e?.message || e); }
}

// ---------------------------------------------------------------------------
// Google Drive through Composio (same consumer key the dashboard collectors use).
export async function composioExecute(tools, { connect } = {}) {
  const key = env("COMPOSIO_CONSUMER_API_KEY", "");
  if (!key) throw Error("COMPOSIO_CONSUMER_API_KEY is not set in Railway");
  const client = connect ? await connect() : await (async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const c = new Client({ name: "xtrachef-sync", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL("https://connect.composio.dev/mcp"), {
      requestInit: { headers: { "x-consumer-api-key": key } }, reconnectionOptions: { maxRetries: 0 },
    }));
    return c;
  })();
  try {
    const res = await client.callTool({
      name: "COMPOSIO_MULTI_EXECUTE_TOOL",
      arguments: { tools, sync_response_to_workbench: false, thought: "xtraCHEF nightly sync", current_step: "XTRACHEF_SYNC" },
    }, undefined, { timeout: 120000 });
    const text = (res.content || []).map(c => c.text || "").join("");
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw Error(`Composio returned non-JSON: ${text.slice(0, 200)}`); }
    const results = parsed?.data?.results;
    if (!Array.isArray(results)) throw Error(`Composio error: ${String(parsed?.error || text).slice(0, 300)}`);
    return results.map(r => {
      if (!r?.response?.successful) throw Error(`${r?.tool_slug || "Composio tool"} failed: ${String(r?.response?.error || r?.error || "unknown").slice(0, 300)}`);
      return r.response.data;
    });
  } finally {
    await client.close().catch(() => {});
  }
}

export async function newestExport(opts) {
  const [data] = await composioExecute([{
    tool_slug: "GOOGLEDRIVE_FIND_FILE", account: DRIVE_ACCOUNT(),
    arguments: { folder_id: FOLDER_ID(), q: "name contains 'Invoices_' and trashed = false", orderBy: "createdTime desc", pageSize: 20, fields: "files(id,name,size,md5Checksum,createdTime,modifiedTime)" },
  }], opts);
  const files = (data?.files || []).filter(f => FILE_RE.test(f.name));
  return files[0] || null;
}

export async function downloadExport(fileId, opts) {
  const [data] = await composioExecute([{ tool_slug: "GOOGLEDRIVE_DOWNLOAD_FILE", account: DRIVE_ACCOUNT(), arguments: { fileId } }], opts);
  const url = data?.downloaded_file_content?.s3url || data?.downloaded_file_content?.url;
  if (!url) throw Error("Drive download returned no file link");
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw Error(`Downloading export from Drive returned HTTP ${res.status}`);
  return (await res.text()).replace(/^﻿/, "");
}

// Feed the dashboard store (Betelgeuse Live prime cost) in-process.
async function importDashboard(csv, fileTime) {
  if (env("DASHBOARD_ENABLED", "") !== "true") return { skipped: "DASHBOARD_ENABLED is not true" };
  const { readExport } = await import("../dashboard/invoice-import.mjs");
  const { importInvoices } = await import("../dashboard/http.mjs");
  const { requestPrimeRefresh } = await import("../dashboard/runner.mjs");
  const parsed = readExport(csv);
  const manifest = {
    schemaVersion: 2, rawCsv: csv, sha256: crypto.createHash("sha256").update(csv).digest("hex"),
    invoiceCount: parsed.groups.size, importedAt: new Date().toISOString(), exportFileAt: fileTime, mode: "cloud-drive-sync",
  };
  const result = importInvoices({ lines: parsed.lines, manifest });
  if (result.changed) requestPrimeRefresh();
  return result;
}

let running = null;
export function syncNow(opts = {}) {
  if (!running) running = runSync(opts).finally(() => { running = null; });
  return running;
}

async function runSync({ force = false, connect } = {}) {
  const prior = readStatus() || {};
  const startedAt = new Date().toISOString();
  const before = store.newestDates();
  try {
    const file = await newestExport({ connect });
    if (!file) throw Error("No Invoices_*.csv found in the xtraCHEF Exports Drive folder");
    if (!force && prior.lastFile?.id === file.id && prior.lastFile?.md5 === file.md5Checksum) {
      const status = { ...prior, lastAttemptAt: startedAt, ok: true, error: null, lastCheck: { at: startedAt, newFile: false, file: file.name } };
      writeStatus(status);
      await alert(health());
      return { ok: true, new_file: false, file: file.name, note: "Newest export already loaded" };
    }
    const csv = await downloadExport(file.id, { connect });
    const mcp = store.replaceInvoicesFromCsv(csv, file.name);
    if (mcp.error) throw Error(`MCP store rejected export: ${mcp.error}`);
    let dashboard;
    try { dashboard = await importDashboard(csv, file.createdTime || startedAt); } catch (e) { dashboard = { error: e?.message || String(e) }; }
    const after = store.newestDates();
    const last = {
      file: file.name, invoices: mcp.invoices, lines: mcp.lines, lines_removed: mcp.removed, lines_added: mcp.added, dashboard,
      newest_upload_before: before.upload_date, newest_upload_after: after.upload_date, newest_invoice_date: after.invoice_date,
    };
    const ok = !dashboard?.error;
    writeStatus({
      ok, lastAttemptAt: startedAt, lastSuccessAt: new Date().toISOString(),
      lastFile: { id: file.id, name: file.name, md5: file.md5Checksum, createdTime: file.createdTime },
      consecutiveFailures: ok ? 0 : (prior.consecutiveFailures || 0) + 1,
      error: ok ? null : `Dashboard import failed: ${dashboard.error}`, last,
      history: [{ at: startedAt, ok, file: file.name, invoices: mcp.invoices, newest_upload: after.upload_date }, ...(prior.history || [])].slice(0, 30),
    });
    await alert(health());
    return { ok, new_file: true, ...last };
  } catch (e) {
    const error = e?.message || String(e);
    writeStatus({
      ...prior, ok: false, lastAttemptAt: startedAt, error, consecutiveFailures: (prior.consecutiveFailures || 0) + 1,
      history: [{ at: startedAt, ok: false, error }, ...(prior.history || [])].slice(0, 30),
    });
    await alert(health());
    return { ok: false, error };
  }
}

// Scheduler: check the Drive folder at each listed Chicago hour (default 3-6 a.m.)
// until that night's new file is loaded, so the 5 a.m. alerts see fresh data.
export function startSyncScheduler() {
  if (env("XTRACHEF_SYNC_ENABLED", "") !== "true") {
    console.error("[xtrachef-sync] disabled (set XTRACHEF_SYNC_ENABLED=true)");
    return;
  }
  const hours = env("XTRACHEF_SYNC_HOURS", "3,4,5,6").split(",").map(Number);
  const tick = async () => {
    const now = new Date();
    if (!hours.includes(localHour(now))) return;
    const s = readStatus();
    const loadedToday = s?.lastSuccessAt && localDate(new Date(s.lastSuccessAt)) === localDate(now) && s.ok;
    const checkedThisHour = s?.lastAttemptAt && now.getTime() - Date.parse(s.lastAttemptAt) < 55 * 60000;
    if (loadedToday || checkedThisHour) return;
    const r = await syncNow();
    console.error("[xtrachef-sync]", JSON.stringify(r).slice(0, 500));
  };
  const timer = setInterval(() => void tick(), 5 * 60000);
  timer.unref();
  void tick();
  console.error(`[xtrachef-sync] enabled, checking Drive at ${hours.join(",")}:00 ${TZ}`);
}
