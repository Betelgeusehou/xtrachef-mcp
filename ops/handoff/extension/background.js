// MV3 service worker: reads vendor cookies (including httpOnly) with chrome.cookies and
// POSTs them as a Playwright storageState to <server>/ops/handoff/<vendor>.
// Runs daily at 3:30 local time and on demand from the popup. Never logs cookie values or the token.
import { DEFAULT_VENDORS, toStorageState, likelySignedIn, fingerprint, msUntil, normalizeBase } from './convert.js';

const ALARM = 'daily-handoff';
const HOUR = 3, MINUTE = 30;

async function schedule() {
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { when: Date.now() + msUntil(HOUR, MINUTE), periodInMinutes: 24 * 60 });
}
chrome.runtime.onInstalled.addListener(() => { schedule(); });
chrome.runtime.onStartup.addListener(async () => { if (!(await chrome.alarms.get(ALARM))) schedule(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) pushAll({ trigger: 'alarm' }); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'push-now') { pushAll({ trigger: 'manual', only: msg.vendor }).then(reply, e => reply({ error: e.message })); return true; }
  if (msg?.type === 'reschedule') { schedule().then(() => reply({ ok: true })); return true; }
  return false;
});

async function config() {
  const { serverBase, token } = await chrome.storage.local.get(['serverBase', 'token']);
  if (!serverBase || !token) throw Error('Set the server URL and token in the extension options first');
  return { base: normalizeBase(serverBase), token };
}

async function vendorList(base, token) {
  try {
    const r = await fetch(`${base}/ops/handoff/vendors`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.vendors) && j.vendors.length) return { vendors: j.vendors, source: 'server' };
    }
  } catch { /* fall back */ }
  return { vendors: DEFAULT_VENDORS, source: 'default' };
}

async function cookiesFor(domains) {
  return Promise.all(domains.map(domain => chrome.cookies.getAll({ domain })));
}

async function pushVendor(v, base, token, prev) {
  const state = toStorageState(await cookiesFor(v.domains));
  const at = new Date().toISOString();
  if (!state.cookies.length) return { at, ok: false, status: 'no-cookies', message: `Not signed in to ${v.name} in Chrome (no cookies).` };
  if (!likelySignedIn(state)) return { at, ok: false, status: 'signed-out', message: `${v.name} looks signed out in Chrome; open ${v.loginUrl || v.domains[0]} and sign in.` };
  const fp = await fingerprint(state);
  // Re-push unchanged sessions at most every 3 days (keeps the server's savedAt fresh without churn).
  if (prev?.ok && prev.fp === fp && Date.now() - Date.parse(prev.pushedAt || 0) < 3 * 86400000) return { ...prev, at, status: 'unchanged' };
  const res = await fetch(`${base}/ops/handoff/${encodeURIComponent(v.id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ storageState: state, url: v.loginUrl || null }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok) return { at, ok: false, status: `http-${res.status}`, message: body.error || `Server returned ${res.status}` };
  return { at, pushedAt: at, ok: true, status: 'pushed', cookies: body.cookies, fp };
}

async function pushAll({ trigger, only } = {}) {
  let base, token;
  try { ({ base, token } = await config()); }
  catch (e) { notify('Ops handoff not configured', e.message); return { error: e.message }; }
  const { vendors, source } = await vendorList(base, token);
  const { results: prevAll = {} } = await chrome.storage.local.get('results');
  const results = { ...prevAll };
  for (const v of vendors) {
    if (only && v.id !== only) continue;
    try { results[v.id] = { name: v.name, ...(await pushVendor(v, base, token, prevAll[v.id])) }; }
    catch (e) { results[v.id] = { name: v.name, at: new Date().toISOString(), ok: false, status: 'error', message: e.message }; }
  }
  await chrome.storage.local.set({ results, lastRun: { at: new Date().toISOString(), trigger, vendorSource: source } });
  const bad = Object.entries(results).filter(([id, r]) => (!only || id === only) && !r.ok);
  if (bad.length) notify('Ops handoff needs you', bad.map(([, r]) => r.message).join('\n'));
  return { results, vendorSource: source };
}

function notify(title, message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title, message: String(message).slice(0, 500), priority: 2 }); }
  catch { /* notifications optional */ }
}
