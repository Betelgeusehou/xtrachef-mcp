// Playwright session runtime: restores a vendor's saved storageState, builds the adapter ctx
// (see ops/README.md), runs fn(ctx), then saves the refreshed storageState back to the vault.
import { getCreds, loadSession, saveSession } from './vault.mjs';
import { totp as totpCode } from './totp.mjs';
import { canonicalStore } from './stores.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Redacts anything that looks like a credential. `known` = literal secret values to scrub.
export function redact(msg, known = []) {
  let s = typeof msg === 'string' ? msg : (() => { try { return JSON.stringify(msg); } catch { return String(msg); } })();
  for (const v of known) if (typeof v === 'string' && v.length >= 4) s = s.split(v).join('[redacted]');
  return s
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)?/g, '[jwt]')
    .replace(/((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|auth[a-z_-]*|cookie|set-cookie|session[a-z_-]*|sid|csrf[a-z_-]*|otp|code)["']?\s*[:=]\s*["']?)[^"'\s,;&}]+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
}

async function importGmail() {
  try { return await import('../inbox/gmail.mjs'); }
  catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('gmail.mjs')) throw Error('Email MFA codes need ops/inbox/gmail.mjs, which is not installed');
    throw e;
  }
}

function matcher(filter) {
  if (!filter) return () => true;
  if (typeof filter === 'string') return url => url.includes(filter);
  if (filter instanceof RegExp) return url => filter.test(url);
  if (typeof filter === 'function') return filter;
  throw Error('capture filter must be a string, RegExp or function');
}

// Builds ctx around an already-open page. Exported so tests / record.mjs can reuse it.
export function buildCtx(adapter, page, { logs = [], mode } = {}) {
  let creds;
  const getC = () => (creds === undefined ? (creds = getCreds(adapter.id)) : creds);
  const secrets = () => Object.values(getC() || {}).filter(v => typeof v === 'string');
  const ctx = {
    page,
    mode,
    adapter,
    get creds() { return getC(); },
    store: canonicalStore,
    logs,
    log(msg) {
      let known = [];
      try { known = secrets(); } catch { known = []; }
      const line = `${new Date().toISOString()} [${adapter.id}] ${redact(msg, known)}`;
      logs.push(line);
      if (process.env.OPS_DEBUG === 'true') console.error(line);
    },
    totp() {
      const s = getC()?.totpSecret;
      if (!s) throw Error(`No totpSecret stored for ${adapter.id}`);
      return totpCode(s);
    },
    async waitForEmailCode(opts = {}) {
      const mod = await importGmail();
      if (typeof mod.waitForEmailCode !== 'function') throw Error('ops/inbox/gmail.mjs does not export waitForEmailCode');
      return mod.waitForEmailCode(opts);
    },
    async api(url, init = {}) {
      const r = await page.evaluate(async ([u, i]) => {
        const res = await fetch(u, { credentials: 'include', ...i });
        return { status: res.status, ok: res.ok, text: await res.text() };
      }, [url, init]);
      if (!r.ok) {
        const e = Error(`${init.method || 'GET'} ${String(url).split('?')[0]} -> HTTP ${r.status}`);
        e.status = r.status;
        e.body = String(r.text).slice(0, 300);
        throw e;
      }
      if (!r.text) return null;
      try { return JSON.parse(r.text); }
      catch { const e = Error(`${String(url).split('?')[0]} returned non-JSON`); e.status = r.status; throw e; }
    },
    async capture(fn, filter) {
      const match = matcher(filter);
      const pending = [];
      const onResponse = res => {
        const url = res.url();
        if (!match(url)) return;
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json')) return;
        pending.push(res.json()
          .then(json => ({ url, method: res.request().method(), status: res.status(), json }))
          .catch(() => null));
      };
      page.on('response', onResponse);
      try { await fn(); }
      finally { page.off('response', onResponse); }
      return (await Promise.all(pending)).filter(Boolean);
    },
  };
  return ctx;
}

let chromiumImpl;
async function chromium() {
  if (!chromiumImpl) chromiumImpl = (await import('playwright')).chromium;
  return chromiumImpl;
}

export async function newContext(browser, storageState) {
  return browser.newContext({
    storageState: storageState || undefined,
    userAgent: UA,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    viewport: { width: 1366, height: 900 },
  });
}

// Runs fn(ctx) inside a browser with the vendor's saved session. Returns fn's result.
// opts.logs: array to collect redacted log lines into. The refreshed session is saved only when
// fn succeeds, so a failed/expired run never overwrites the last good session.
export async function withSession(adapter, fn, { headless = true, mode, logs = [] } = {}) {
  const saved = loadSession(adapter.id);
  const browser = await (await chromium()).launch({ headless, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const context = await newContext(browser, saved?.storageState);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const ctx = buildCtx(adapter, page, { logs, mode });
    if (adapter.loginUrl) await page.goto(adapter.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const out = await fn(ctx);
    saveSession(adapter.id, await context.storageState(), { source: 'refresh' });
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function sessionAlive(adapter, opts = {}) {
  if (typeof adapter.isLoggedIn !== 'function') return false;
  try {
    return await withSession(adapter, async ctx => {
      const ok = !!(await adapter.isLoggedIn(ctx));
      if (!ok) throw Object.assign(Error('not logged in'), { notLoggedIn: true });
      return true;
    }, opts);
  } catch (e) {
    if (e?.notLoggedIn) return false;
    throw e;
  }
}
