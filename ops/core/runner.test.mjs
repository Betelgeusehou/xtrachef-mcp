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
