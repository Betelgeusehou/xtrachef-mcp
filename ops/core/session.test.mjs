import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.OPS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-session-'));
const { buildCtx, redact } = await import('./session.mjs');
const { summarizeCall, summarizeEndpoints, sampleJson } = await import('./record.mjs');

test('redact scrubs tokens, cookies, passwords and known secrets', () => {
  const s = redact('Authorization: Bearer abcdefghijklmnop123 password=hunter2 cookie: sid=xyz {"token":"t0k3n"} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig', ['MySecretPw']);
  assert.ok(!/abcdefghijklmnop123|hunter2|t0k3n|eyJhbGci/.test(s), s);
  assert.equal(redact('logging in as MySecretPw now', ['MySecretPw']), 'logging in as [redacted] now');
  assert.equal(redact('fetched 12 orders for 2026-11-05'), 'fetched 12 orders for 2026-11-05');
});

function fakePage(responses = []) {
  const page = new EventEmitter();
  page.off = page.removeListener.bind(page);
  page.evaluate = async (fn, [url, init]) => {
    assert.equal(typeof fn, 'function');
    if (url.includes('fail')) return { status: 403, ok: false, text: 'nope' };
    return { status: 200, ok: true, text: JSON.stringify({ url, method: init.method || 'GET' }) };
  };
  page.fire = () => {
    for (const r of responses) page.emit('response', {
      url: () => r.url, status: () => 200, headers: () => ({ 'content-type': r.ct }),
      request: () => ({ method: () => 'GET' }), json: async () => r.json,
    });
  };
  return page;
}

test('ctx.api parses JSON and throws with status on non-2xx', async () => {
  const ctx = buildCtx({ id: 'demo' }, fakePage());
  assert.deepEqual(await ctx.api('https://x.test/a', { method: 'POST' }), { url: 'https://x.test/a', method: 'POST' });
  await assert.rejects(ctx.api('https://x.test/fail'), e => e.status === 403);
});

test('ctx.capture keeps only matching JSON responses', async () => {
  const page = fakePage([
    { url: 'https://x.test/api/orders?d=1', ct: 'application/json', json: { orders: [1] } },
    { url: 'https://x.test/api/orders.js', ct: 'text/javascript', json: null },
    { url: 'https://x.test/other', ct: 'application/json', json: {} },
  ]);
  const ctx = buildCtx({ id: 'demo' }, page);
  const got = await ctx.capture(async () => page.fire(), /\/api\/orders/);
  assert.deepEqual(got, [{ url: 'https://x.test/api/orders?d=1', method: 'GET', status: 200, json: { orders: [1] } }]);
  assert.equal(page.listenerCount('response'), 0);
});

test('ctx.totp, ctx.store, ctx.log redaction, waitForEmailCode error', async () => {
  process.env.OPS_CREDS_DEMO = JSON.stringify({ username: 'chris', password: 'Sup3rS3cret!', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
  const ctx = buildCtx({ id: 'demo' }, fakePage());
  assert.match(ctx.totp(), /^\d{6}$/);
  assert.equal(ctx.store('Betelgeuse Montrose'), 'Montrose');
  ctx.log('typed password Sup3rS3cret! into form');
  assert.ok(!ctx.logs[0].includes('Sup3rS3cret!'));
  if (!fs.existsSync(new URL('../inbox/gmail.mjs', import.meta.url))) await assert.rejects(ctx.waitForEmailCode({}), /ops\/inbox\/gmail\.mjs/);
  delete process.env.OPS_CREDS_DEMO;
});

test('record summarizer groups endpoints and truncates samples', () => {
  const big = { data: { rows: Array.from({ length: 50 }, (_, i) => ({ id: i, name: 'x'.repeat(200) })) }, total: 50 };
  const c1 = summarizeCall({ method: 'GET', url: 'https://m.test/api/v1/stores/123456/orders?from=2026-11-01&to=2026-11-05', status: 200, json: big });
  const c2 = summarizeCall({ method: 'GET', url: 'https://m.test/api/v1/stores/987654/orders?from=2026-11-02&page=2', status: 200, json: [{ a: 1 }] });
  assert.deepEqual(c1.keys, ['data', 'total']);
  assert.ok(c1.sample.length <= 601);
  assert.deepEqual(c2.keys, ['[array]', '[].a']);
  const eps = summarizeEndpoints([c1, c2]);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].endpoint, 'https://m.test/api/v1/stores/:id/orders');
  assert.equal(eps[0].count, 2);
  assert.deepEqual(eps[0].params, ['from', 'to', 'page']);
  assert.deepEqual(sampleJson([1, 2, 3, 4]), [1, 2, '…+2']);
});
