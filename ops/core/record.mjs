#!/usr/bin/env node
// Endpoint recorder. Run on your own laptop, once per vendor:
//   OPS_VAULT_KEY=... node ops/core/record.mjs doordash [--out doordash-endpoints.json] [--url https://...]
// A real (headed) Chromium opens at the vendor's login page. Sign in, click through every report you
// care about, then close the window (or press Ctrl+C). Every JSON XHR/fetch is logged to the --out
// file, and the signed-in session is saved to the vault (source 'record') so the server can reuse it.
// The log holds endpoint shapes and truncated samples only; request headers and cookies are never written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveSession } from './vault.mjs';
import { redact } from './session.mjs';

const SAMPLE_CHARS = 600;

// Truncates a JSON value to a small structural sample.
export function sampleJson(v, depth = 0) {
  if (Array.isArray(v)) return depth > 3 ? `[array(${v.length})]` : v.slice(0, 2).map(x => sampleJson(x, depth + 1)).concat(v.length > 2 ? [`…+${v.length - 2}`] : []);
  if (v && typeof v === 'object') {
    if (depth > 3) return '{…}';
    const out = {};
    for (const k of Object.keys(v).slice(0, 25)) out[k] = sampleJson(v[k], depth + 1);
    return out;
  }
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v;
  return v;
}

const topKeys = json => Array.isArray(json) ? ['[array]', ...(json[0] && typeof json[0] === 'object' && !Array.isArray(json[0]) ? Object.keys(json[0]).map(k => `[].${k}`) : [])]
  : json && typeof json === 'object' ? Object.keys(json) : [typeof json];

// One raw capture -> a log entry.
export function summarizeCall({ method, url, status, json, postData }) {
  const sample = redact(JSON.stringify(sampleJson(json)) ?? 'null');
  return {
    method, url: redact(url), status,
    keys: topKeys(json),
    ...(postData ? { body: redact(String(postData)).slice(0, 400) } : {}),
    sample: sample.length > SAMPLE_CHARS ? sample.slice(0, SAMPLE_CHARS) + '…' : sample,
  };
}

// Collapses calls into one row per endpoint (method + path, query values stripped to names).
export function summarizeEndpoints(calls) {
  const by = new Map();
  for (const c of calls) {
    let u;
    try { u = new URL(c.url); } catch { continue; }
    const pathPattern = u.pathname.replace(/\/\d{3,}(?=\/|$)/g, '/:id').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:uuid');
    const key = `${c.method} ${u.origin}${pathPattern}`;
    const e = by.get(key) || { method: c.method, endpoint: `${u.origin}${pathPattern}`, count: 0, statuses: [], params: [], keys: [], example: c.url };
    e.count++;
    if (!e.statuses.includes(c.status)) e.statuses.push(c.status);
    for (const p of u.searchParams.keys()) if (!e.params.includes(p)) e.params.push(p);
    for (const k of c.keys || []) if (!e.keys.includes(k)) e.keys.push(k);
    by.set(key, e);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

const STATIC = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)(\?|$)/i;
const NOISE = /(google-analytics|googletagmanager|doubleclick|segment\.(io|com)|sentry|datadoghq|hotjar|fullstory|newrelic|intercom|launchdarkly|amplitude|mixpanel|braze|optimizely)/i;

function parseArgs(argv) {
  const a = { vendor: null, out: null, url: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--url') a.url = argv[++i];
    else if (!a.vendor) a.vendor = argv[i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vendor) {
    console.error('usage: node ops/core/record.mjs <vendorId> [--out file.json] [--url startUrl]');
    process.exit(2);
  }
  // On a laptop there is no /data volume; keep the encrypted session next to the repo unless told otherwise.
  if (!process.env.OPS_DATA_DIR && !process.env.XTRACHEF_DATA_DIR) process.env.OPS_DATA_DIR = path.resolve('data/ops');
  (await import('./vault.mjs')).vaultKey(); // fail fast if OPS_VAULT_KEY is missing/wrong
  let startUrl = args.url;
  if (!startUrl) {
    const { getAdapter } = await import('./registry.mjs');
    startUrl = (await getAdapter(args.vendor))?.loginUrl;
  }
  if (!startUrl) { console.error(`No adapter loginUrl for ${args.vendor}; pass --url`); process.exit(2); }
  const out = path.resolve(args.out || `${args.vendor}-endpoints-${new Date().toISOString().slice(0, 10)}.json`);

  const { chromium } = await import('playwright');
  const { newContext } = await import('./session.mjs');
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await newContext(browser, null);
  const calls = [];
  const pending = new Set();
  let lastState = null;

  const write = () => {
    fs.writeFileSync(out, JSON.stringify({ vendor: args.vendor, startUrl, recordedAt: new Date().toISOString(), endpoints: summarizeEndpoints(calls), calls }, null, 2));
  };
  context.on('response', res => {
    const req = res.request();
    if (!['xhr', 'fetch'].includes(req.resourceType())) return;
    const url = res.url();
    if (STATIC.test(url) || NOISE.test(url)) return;
    if (!(res.headers()['content-type'] || '').includes('json')) return;
    const p = res.json().then(json => {
      calls.push(summarizeCall({ method: req.method(), url, status: res.status(), json, postData: req.postData() }));
      console.log(`${req.method()} ${res.status()} ${url.split('?')[0]}`);
      write();
    }).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  });

  const page = await context.newPage();
  // Snapshot storageState periodically so it survives the window being closed.
  const snap = setInterval(async () => { try { lastState = await context.storageState(); } catch {} }, 3000);
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    clearInterval(snap);
    try { lastState = await context.storageState(); } catch {}
    await Promise.allSettled([...pending]);
    write();
    if (lastState?.cookies?.length) {
      saveSession(args.vendor, lastState, { source: 'record' });
      console.log(`Saved session for ${args.vendor} (${lastState.cookies.length} cookies) to the vault.`);
    } else console.log('No cookies captured; session not saved.');
    console.log(`Logged ${calls.length} JSON calls across ${summarizeEndpoints(calls).length} endpoints -> ${out}`);
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', finish);
  page.on('close', finish);
  browser.on('disconnected', finish);
  console.log(`Opening ${startUrl}. Sign in, click through your reports, then close the window.`);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.error(e.message));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e?.message || e); process.exit(1); });
}
