import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-health-'));
const { opsHealth } = await import('./health.mjs');
const S = await import('./store.mjs');

const NOW = new Date('2026-11-07T15:00:00Z');
const ago = h => new Date(NOW.getTime() - h * 3600000).toISOString();
function run(vendor, ok, finished, mode = 'session', error = null) {
  S.open().prepare('INSERT INTO runs (vendor, mode, started_at, finished_at, ok, records, error) VALUES (?,?,?,?,?,?,?)').run(vendor, mode, finished, finished, ok ? 1 : 0, ok ? 5 : 0, error);
}
const A = (id, modes) => ({ id, name: id, domain: 'delivery', modes, kinds: [] });

test('flags stale, old session, failed last run, missing creds', async () => {
  run('fresh', true, ago(2));
  run('stale', true, ago(48));
  run('failing', true, ago(3));
  run('failing', false, ago(1), 'session', 'session expired — needs handoff');
  run('nocreds', true, ago(1), 'login');
  const list = [A('fresh', ['session']), A('stale', ['session']), A('failing', ['session', 'inbox']), A('nocreds', ['login']), A('oldsess', ['handoff'])];
  list.errors = [];
  const vault = [
    { vendor: 'fresh', hasCreds: false, hasSession: true, sessionSavedAt: ago(24) },
    { vendor: 'stale', hasCreds: false, hasSession: true, sessionSavedAt: ago(24) },
    { vendor: 'failing', hasCreds: false, hasSession: true, sessionSavedAt: ago(24) },
    { vendor: 'nocreds', hasCreds: false, hasSession: true, sessionSavedAt: ago(1) },
    { vendor: 'oldsess', hasCreds: false, hasSession: true, sessionSavedAt: ago(21 * 24) },
  ];
  const h = await opsHealth(NOW, { adaptersImpl: async () => list, vaultImpl: () => vault });
  const by = Object.fromEntries(h.vendors.map(v => [v.vendor, v]));
  assert.equal(h.state, 'ALERT');
  assert.deepEqual(by.fresh.problems, []);
  assert.equal(by.fresh.lastRun.ok, true);
  assert.match(by.stale.problems.join(), /no success in 48h/);
  assert.match(by.failing.problems.join(), /last run failed \(session\): session expired/);
  assert.match(by.nocreds.problems.join(), /credentials missing/);
  assert.match(by.oldsess.problems.join(), /session is 21 days old/);
  assert.match(by.oldsess.problems.join(), /never succeeded/);
  assert.ok(h.problems.includes('stale: no success in 48h'));
  assert.ok(!JSON.stringify(h).match(/password|cookie/i));
});

test('ok when everything is healthy', async () => {
  const list = [A('fresh', ['session'])];
  const h = await opsHealth(NOW, { adaptersImpl: async () => list, vaultImpl: () => [{ vendor: 'fresh', hasCreds: true, hasSession: true, sessionSavedAt: ago(1) }] });
  assert.equal(h.state, 'ok');
  assert.deepEqual(h.problems, []);
  assert.equal(h.enabled, false);
});

test('surfaces invalid vendor files and vault errors', async () => {
  const list = [];
  list.errors = [{ file: 'bad.mjs', problems: ['unknown kind x'] }];
  const h = await opsHealth(NOW, { adaptersImpl: async () => list, vaultImpl: () => { throw Error('OPS_VAULT_KEY is not set'); } });
  assert.equal(h.state, 'ALERT');
  assert.ok(h.problems.some(p => p.includes('bad.mjs')));
  assert.ok(h.problems.some(p => p.includes('vault unreadable')));
});

test('surfaces unmatched inbox report files as a top-level problem', async () => {
  const at = ago(2);
  const ins = S.open().prepare('INSERT INTO runs (vendor, mode, started_at, finished_at, ok, records, error) VALUES (?,?,?,?,?,?,?)');
  ins.run('inbox:unmatched', 'inbox', at, at, 0, 0, 'unmatched report file a.csv: no adapter matched');
  ins.run('inbox:unmatched', 'inbox', ago(1), ago(1), 0, 0, 'unmatched report file a.csv: no adapter matched');
  ins.run('inbox:unmatched', 'inbox', at, at, 0, 0, 'unmatched report file b.pdf: no adapter matched');
  ins.run('inbox:unmatched', 'inbox', ago(100), ago(100), 0, 0, 'unmatched report file old.csv: no adapter matched');
  const h = await opsHealth(NOW, { adaptersImpl: async () => [], vaultImpl: () => [] });
  assert.equal(h.state, 'ALERT');
  assert.equal(h.problems[0], '2 unmatched report files in the inbox');
  assert.equal(h.unmatched.length, 2);
  assert.ok(!h.vendors.some(v => v.vendor === 'inbox:unmatched'));
});
