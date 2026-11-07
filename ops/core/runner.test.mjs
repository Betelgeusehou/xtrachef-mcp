import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-runner-'));
delete process.env.OPS_ALERT_WEBHOOK;
delete process.env.XTRACHEF_ALERT_WEBHOOK;
const R = await import('./runner.mjs');
const S = await import('./store.mjs');
const { canonicalStore } = await import('./stores.mjs');

// Fake withSession: no browser, records which modes opened a session.
const opened = [];
const fakeWithSession = async (adapter, fn, { mode, logs = [] } = {}) => {
  opened.push(`${adapter.id}:${mode}`);
  return fn({ page: null, mode, store: canonicalStore, log: m => logs.push(String(m)) });
};
const order = (id, bd = '2026-11-05') => ({ delivery_orders: [{ vendor: id, store: 'Montrose', business_date: bd, order_id: `${id}-1`, payout: 12.5 }] });
const base = id => ({ id, name: id, domain: 'delivery', kinds: ['delivery_orders'], loginUrl: 'https://x.test/', matchFile: () => false, parseFile: () => ({}) });

test('defaultRange = last 3 days through yesterday, Chicago', () => {
  assert.deepEqual(R.defaultRange(new Date('2026-11-07T15:00:00Z')), { from: '2026-11-04', through: '2026-11-06' });
  // 03:00Z on the 7th is still the 6th in Chicago
  assert.deepEqual(R.defaultRange(new Date('2026-11-07T03:00:00Z')), { from: '2026-11-03', through: '2026-11-05' });
});

test('modes run in order; failure falls through to the next mode', async () => {
  const seen = [];
  const a = { ...base('fall-through'), modes: ['api', 'session', 'inbox'],
    async isLoggedIn() { return true; },
    async collect(ctx, range) { seen.push(ctx.mode); if (ctx.mode === 'api') throw Error('api down'); assert.equal(range.through, '2026-11-06'); return order('fall-through'); } };
  const r = await R.runVendor(a.id, { adapter: a, withSessionImpl: fakeWithSession, range: { from: '2026-11-04', through: '2026-11-06' } });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'session');
  assert.equal(r.records, 1);
  assert.deepEqual(seen, ['api', 'session']);
  assert.deepEqual(r.attempts.map(x => [x.mode, x.ok]), [['api', false], ['session', true]]);
  assert.equal(S.query('delivery_orders', { vendor: 'fall-through' })[0].source_mode, 'session');
  const runs = S.open().prepare("SELECT mode, ok FROM runs WHERE vendor='fall-through' ORDER BY id").all().map(x => [x.mode, x.ok]);
  assert.deepEqual(runs, [['api', 0], ['session', 1]]);
});

test('expired session with no creds fails with handoff reason; handoff not retried', async () => {
  opened.length = 0;
  const a = { ...base('expired'), modes: ['session', 'handoff', 'inbox'], async isLoggedIn() { return false; }, async collect() { throw Error('should not collect'); } };
  const r = await R.runVendor(a.id, { adapter: a, withSessionImpl: fakeWithSession });
  assert.equal(r.ok, false);
  assert.equal(r.error, R.EXPIRED);
  assert.deepEqual(opened, ['expired:session']);
  assert.deepEqual(r.attempts.map(x => x.skipped ? `${x.mode}:skip` : x.mode), ['session', 'handoff:skip', 'inbox:skip']);
});

test('login is folded into session when creds exist', async () => {
  process.env.OPS_CREDS_WITH_LOGIN = JSON.stringify({ username: 'u', password: 'p' });
  let loggedIn = false, logins = 0;
  const a = { ...base('with-login'), modes: ['session', 'login'],
    async isLoggedIn() { return loggedIn; }, async login() { logins++; loggedIn = true; }, async collect() { return order('with-login'); } };
  const r = await R.runVendor(a.id, { adapter: a, withSessionImpl: fakeWithSession });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'session');
  assert.equal(logins, 1);
  delete process.env.OPS_CREDS_WITH_LOGIN;
});

test('login not attempted without creds', async () => {
  let logins = 0;
  const a = { ...base('no-creds'), modes: ['login'], async isLoggedIn() { return false; }, async login() { logins++; }, async collect() { return {}; } };
  const r = await R.runVendor(a.id, { adapter: a, withSessionImpl: fakeWithSession });
  assert.equal(r.ok, false);
  assert.equal(logins, 0);
});

test('inbox/drive-only vendor is skipped by runVendor', async () => {
  const a = { ...base('mail-only'), modes: ['inbox', 'drive'] };
  const r = await R.runVendor(a.id, { adapter: a, withSessionImpl: fakeWithSession });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.ok(r.attempts.every(x => x.skipped));
});

test('runAll serializes vendors, runs inbox sweep, alerts once per vendor per day', async () => {
  process.env.OPS_ALERT_WEBHOOK = 'https://alerts.test/hook';
  let active = 0, maxActive = 0;
  const slowSession = async (adapter, fn, o) => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 10)); try { return await fakeWithSession(adapter, fn, o); } finally { active--; } };
  const list = [
    { ...base('v-ok'), modes: ['session'], async isLoggedIn() { return true; }, async collect() { return order('v-ok'); } },
    { ...base('v-bad'), modes: ['session'], async isLoggedIn() { return false; }, async collect() { return {}; } },
    { ...base('v-mail'), modes: ['inbox'] },
  ];
  const posts = [];
  const fetchImpl = async (url, init) => { posts.push({ url, body: init.body }); return { ok: true }; };
  const inboxImport = async () => ({ sweepInbox: async () => [{ vendor: 'v-mail', mode: 'inbox', result: order('v-mail') }] });
  const opts = { adaptersImpl: async () => list, inboxImport, withSessionImpl: slowSession, fetchImpl, now: new Date('2026-11-07T15:00:00Z') };
  const [one, two] = await Promise.all([R.runAll(opts), R.runAll(opts)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(one.results.map(r => [r.vendor, r.ok]), [['v-ok', true], ['v-bad', false]]);
  assert.equal(one.inbox.results[0].records, 1);
  assert.equal(S.query('delivery_orders', { vendor: 'v-mail' }).length, 1);
  assert.equal(two.ok, false);
  assert.equal(posts.length, 1, 'second run the same day does not re-alert');
  assert.match(posts[0].body, /v-bad \(session\): session expired/);
  assert.ok(!/password|cookie/i.test(posts[0].body));
  delete process.env.OPS_ALERT_WEBHOOK;
});

test('runAll tolerates a missing inbox module', async () => {
  const missing = async () => { const e = Error("Cannot find module '../inbox/index.mjs'"); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; };
  const out = await R.runAll({ adaptersImpl: async () => [], inboxImport: missing, alert: false });
  assert.equal(out.inbox.skipped, true);
  assert.equal(out.ok, true);
});

test('tick runs only when enabled, in a sync hour, once per hour across restarts', async () => {
  const calls = [];
  const opts = { adaptersImpl: async () => { calls.push(1); return []; }, inboxImport: async () => ({}), alert: false };
  process.env.OPS_SYNC_HOURS = '4,14';
  delete process.env.OPS_ENABLED;
  const inHour = new Date('2026-11-07T20:05:00Z'); // 14:05 Chicago (CST)
  assert.equal(await R.tick(inHour, opts), null);
  process.env.OPS_ENABLED = 'true';
  assert.equal(await R.tick(new Date('2026-11-07T19:05:00Z'), opts), null); // 13:05, not a sync hour
  assert.ok(await R.tick(inHour, opts));
  assert.equal(await R.tick(new Date('2026-11-07T20:45:00Z'), opts), null);
  assert.equal(calls.length, 1);
  const st = R.readStatus();
  assert.equal(st.lastKey, '2026-11-07T14');
  assert.equal(st.state, 'ok');
  delete process.env.OPS_ENABLED;
  delete process.env.OPS_SYNC_HOURS;
});

// ---- review fixes ----------------------------------------------------------------------------------

test('scheduler never produces an unhandled rejection when /data is unwritable', async () => {
  const unhandled = [];
  const onUR = e => unhandled.push(e);
  process.on('unhandledRejection', onUR);
  const prevDir = process.env.OPS_DATA_DIR;
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-broken-'));
  fs.mkdirSync(path.join(broken, 'run-status.json')); // every status write now fails (rename onto a dir)
  process.env.OPS_DATA_DIR = broken;
  process.env.OPS_ENABLED = 'true';
  process.env.OPS_SYNC_HOURS = '14';
  const origErr = console.error; const errs = []; console.error = (...a) => errs.push(a.join(' '));
  try {
    const opts = { adaptersImpl: async () => [], inboxImport: async () => ({}), alert: false };
    const at = new Date('2026-11-08T20:05:00Z');
    assert.equal(await R.tick(at, opts), null);
    assert.equal(await R.safeTick(at, opts), null);
    assert.ok(errs.some(e => e.includes('[ops]')));
    await new Promise(r => setImmediate(r));
    assert.deepEqual(unhandled, []);
  } finally {
    console.error = origErr;
    process.off('unhandledRejection', onUR);
    process.env.OPS_DATA_DIR = prevDir;
    delete process.env.OPS_ENABLED;
    delete process.env.OPS_SYNC_HOURS;
  }
});

test('safeTick swallows a rejecting tick', async () => {
  const origErr = console.error; console.error = () => {};
  process.env.OPS_ENABLED = 'true';
  process.env.OPS_SYNC_HOURS = '14';
  try {
    const out = await R.safeTick(new Date('2026-11-09T20:05:00Z'), { adaptersImpl: async () => { throw Error('boom'); }, inboxImport: async () => ({}), alert: false });
    assert.equal(out, null);
  } finally { console.error = origErr; delete process.env.OPS_ENABLED; delete process.env.OPS_SYNC_HOURS; }
});

test('runVendorLocked and withBrowserLock share the runner lock', async () => {
  assert.equal(typeof R.runVendorLocked, 'function');
  assert.equal(typeof R.withBrowserLock, 'function');
  let active = 0, maxActive = 0;
  const slow = async (adapter, fn, o) => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 10)); try { return await fakeWithSession(adapter, fn, o); } finally { active--; } };
  const a = { ...base('locked-v'), modes: ['session'], async isLoggedIn() { return true; }, async collect() { return order('locked-v'); } };
  const outside = () => R.withBrowserLock(async () => { active++; maxActive = Math.max(maxActive, active); assert.equal(R.isRunning(), true); await new Promise(r => setTimeout(r, 10)); active--; return 'done'; });
  const [x, y, z] = await Promise.all([
    R.runVendorLocked(a.id, { adapter: a, withSessionImpl: slow }),
    outside(),
    R.runAll({ adaptersImpl: async () => [a], inboxImport: async () => ({}), withSessionImpl: slow, alert: false }),
  ]);
  assert.equal(maxActive, 1);
  assert.equal(x.ok, true);
  assert.equal(y, 'done');
  assert.equal(z.ok, true);
  // A rejection inside the lock reaches the caller but does not jam the chain.
  await assert.rejects(R.withBrowserLock(async () => { throw Error('inner'); }), /inner/);
  assert.equal(await R.withBrowserLock(async () => 7), 7);
});

test('errors are redacted (vendor creds, url query strings) in result, runs table and alert', async () => {
  process.env.OPS_CREDS_LEAKY = JSON.stringify({ username: 'chris@example.com', password: 'SuperSecretPw1' });
  process.env.OPS_ALERT_WEBHOOK = 'https://alerts.test/hook';
  const a = { ...base('leaky'), modes: ['api'],
    async collect() { throw Error('login failed for chris@example.com / SuperSecretPw1 at https://portal.test/api/v1/orders?access=abc123&store=9#frag'); } };
  const r = await R.runVendor(a.id, { adapter: a });
  assert.equal(r.ok, false);
  for (const s of [r.error, r.attempts[0].error]) {
    assert.ok(!s.includes('SuperSecretPw1'), s);
    assert.ok(!s.includes('chris@example.com'), s);
    assert.ok(!s.includes('access=abc123'), s);
    assert.match(s, /https:\/\/portal\.test\/api\/v1\/orders/);
  }
  const row = S.open().prepare("SELECT error FROM runs WHERE vendor='leaky' ORDER BY id DESC").get();
  assert.ok(!/SuperSecretPw1|abc123|chris@example/.test(row.error), row.error);
  const posts = [];
  await R.alertFailures([{ vendor: 'leaky', mode: 'api', ok: false, error: 'raw SuperSecretPw1 https://x.test/p?token=zzz' }],
    { fetchImpl: async (u, i) => { posts.push(i.body); return { ok: true }; }, now: new Date('2026-11-07T15:00:00Z') });
  assert.equal(posts.length, 1);
  assert.ok(!/SuperSecretPw1|zzz/.test(posts[0]), posts[0]);
  assert.match(posts[0], /https:\/\/x\.test\/p/);
  delete process.env.OPS_CREDS_LEAKY;
  delete process.env.OPS_ALERT_WEBHOOK;
});

test('stripUrlQueries keeps origin + path', () => {
  assert.equal(R.stripUrlQueries('GET https://a.test/x/y?k=v&t=1 -> 500 (see http://b.test/?q=1#h)'), 'GET https://a.test/x/y -> 500 (see http://b.test/)');
});

test('inbox sweep failures from adapters are redacted too', async () => {
  process.env.OPS_CREDS_INBOX_LEAK = JSON.stringify({ password: 'PwFromVault99' });
  const inboxImport = async () => ({ sweepInbox: async () => [{ vendor: 'inbox-leak', mode: 'inbox', ok: false, error: 'parse failed: PwFromVault99 https://h.test/a?sig=qq' }] });
  const out = await R.runAll({ adaptersImpl: async () => [], inboxImport, alert: false });
  assert.ok(!/PwFromVault99|sig=qq/.test(out.inbox.results[0].error));
  delete process.env.OPS_CREDS_INBOX_LEAK;
});

test('unmatched inbox files are recorded as inbox:unmatched and alerted once per file', async () => {
  process.env.OPS_ALERT_WEBHOOK = 'https://alerts.test/hook';
  const posts = [];
  const fetchImpl = async (u, i) => { posts.push(i.body); return { ok: true }; };
  let files = ['mystery-report.csv'];
  const inboxImport = async () => ({ sweepInbox: async () => files.map(f => ({ vendor: null, mode: 'inbox', messageId: 'm1', file: f, records: 0, ok: false, error: 'no adapter matched' })) });
  const opts = { adaptersImpl: async () => [], inboxImport, fetchImpl, now: new Date('2026-11-07T15:00:00Z') };
  const one = await R.runAll(opts);
  assert.equal(one.ok, false);
  assert.deepEqual(one.inbox.results.map(r => [r.vendor, r.ok, r.file]), [[R.UNMATCHED, false, 'mystery-report.csv']]);
  assert.match(one.inbox.results[0].error, /mystery-report\.csv/);
  const rows = S.open().prepare('SELECT ok, error FROM runs WHERE vendor = ?').all(R.UNMATCHED);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, 0);
  assert.match(rows[0].error, /unmatched report file mystery-report\.csv: no adapter matched/);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /inbox:unmatched \(inbox\): unmatched report file mystery-report\.csv/);
  // Same file next day: no repeat alert. A new file: alerted, once, even if listed twice.
  await R.runAll({ ...opts, now: new Date('2026-11-08T15:00:00Z') });
  assert.equal(posts.length, 1);
  files = ['mystery-report.csv', 'other.pdf', 'other.pdf'];
  await R.runAll({ ...opts, now: new Date('2026-11-08T15:00:00Z') });
  assert.equal(posts.length, 2);
  assert.match(posts[1], /other\.pdf/);
  assert.ok(!posts[1].includes('mystery-report.csv'));
  assert.equal(posts[1].split('\n').length, 1);
  delete process.env.OPS_ALERT_WEBHOOK;
});

test('vendor-less sweep errors without a file are recorded under inbox', async () => {
  const inboxImport = async () => ({ sweepInbox: async () => [{ vendor: null, mode: 'drive', file: null, ok: false, error: 'drive sweep failed: HTTP 403 https://g.test/files?key=k1' }] });
  const out = await R.runAll({ adaptersImpl: async () => [], inboxImport, alert: false });
  assert.deepEqual(out.inbox.results.map(r => [r.vendor, r.mode, r.ok]), [['inbox', 'drive', false]]);
  assert.ok(!out.inbox.results[0].error.includes('key=k1'));
});
