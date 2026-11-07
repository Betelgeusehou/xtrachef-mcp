import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleOps, validateStorageState, allowedDomains, registrableDomain, domainAllowed, checkHandoffToken, MAX_HANDOFF_BYTES } from './http.mjs';

const TOKEN = 'x'.repeat(40);
const adapters = {
  doordash: { id: 'doordash', name: 'DoorDash', modes: ['session'], loginUrl: 'https://merchant-portal.doordash.com/' },
  ubereats: { id: 'ubereats', name: 'Uber Eats', modes: ['handoff'], loginUrl: 'https://merchants.ubereats.com/manager', handoffDomains: ['uber.com'] },
  inboxonly: { id: 'inboxonly', name: 'Inbox', modes: ['inbox'] },
};
const registry = { getAdapter: async id => adapters[id] ?? null, adapters: async () => Object.assign(Object.values(adapters), { errors: [] }) };

function fakeReq({ method = 'POST', url = '/x/ops/handoff/doordash', headers = {}, body } = {}) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(buf.length ? [buf] : []);
  req.method = method; req.url = url; req.headers = { 'content-length': String(buf.length), ...headers };
  return req;
}
function fakeRes() {
  const res = { status: 0, headers: {}, body: '', headersSent: false };
  res.writeHead = (s, h) => { res.status = s; res.headers = h; res.headersSent = true; };
  res.end = b => { res.body = b || ''; };
  res.json = () => JSON.parse(res.body);
  return res;
}
function deps(over = {}) {
  const saved = [], runs = [], logs = [];
  return {
    saved, runs, logs,
    token: TOKEN, registry,
    vault: { saveSession: (id, s, o) => { saved.push({ id, s, o }); return { savedAt: 'now', source: o.source }; } },
    runner: { runVendor: async (id) => { runs.push(id); return { vendor: id, ok: true, records: 3 }; } },
    log: (...a) => logs.push(a.join(' ')),
    ...over,
  };
}
const goodState = {
  cookies: [
    { name: 'dd_session', value: 'SECRETVALUE', domain: '.doordash.com', path: '/', expires: 1893456000, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'evil', value: 'v', domain: '.evil.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
  ],
  origins: [{ origin: 'https://merchant-portal.doordash.com', localStorage: [{ name: 'k', value: 'v' }] }, { origin: 'https://evil.com', localStorage: [] }],
};
const post = (d, h, body = { storageState: goodState }, url) => { const res = fakeRes(); return handleOps(fakeReq({ headers: h, body, url }), res, new URL(url || '/x/ops/handoff/doordash', 'http://l').pathname.replace(/^\/x/, ''), d).then(handled => ({ handled, res })); };

test('handoff auth: missing token env -> 503', async () => {
  const d = deps({ token: undefined });
  const prev = process.env.OPS_HANDOFF_TOKEN; delete process.env.OPS_HANDOFF_TOKEN;
  const { handled, res } = await post(d, { authorization: `Bearer ${TOKEN}` });
  process.env.OPS_HANDOFF_TOKEN = prev ?? '';
  if (prev === undefined) delete process.env.OPS_HANDOFF_TOKEN;
  assert.equal(handled, true);
  assert.equal(res.status, 503);
  assert.equal(d.saved.length, 0);
  assert.equal(checkHandoffToken('Bearer short', 'short'), 'unconfigured');
});

test('handoff auth: bad or missing bearer -> 401', async () => {
  for (const h of [{}, { authorization: 'Bearer nope' }, { authorization: TOKEN }]) {
    const d = deps();
    const { res } = await post(d, h);
    assert.equal(res.status, 401);
    assert.equal(d.saved.length, 0);
  }
});

test('handoff good token: saves filtered session via injected vault, kicks sync, never echoes cookies', async () => {
  const d = deps();
  const { res } = await post(d, { authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
  const j = res.json();
  assert.deepEqual(j, { ok: true, vendor: 'doordash', cookies: 1, dropped: 2, sync: 'started' });
  assert.ok(!res.body.includes('SECRETVALUE'));
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0].id, 'doordash');
  assert.deepEqual(d.saved[0].o, { source: 'handoff' });
  assert.deepEqual(d.saved[0].s.cookies.map(c => c.name), ['dd_session']);
  assert.deepEqual(d.saved[0].s.origins.map(o => o.origin), ['https://merchant-portal.doordash.com']);
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(d.runs, ['doordash']);
  assert.ok(d.logs.every(l => !l.includes('SECRETVALUE')));
});

test('handoff: unknown vendor 404, bad shape 400, oversize 413, GET 405', async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await post(deps(), auth, { storageState: goodState }, '/x/ops/handoff/nope')).res.status, 404);
  assert.equal((await post(deps(), auth, { storageState: { cookies: 'x' } })).res.status, 400);
  assert.equal((await post(deps(), auth, { storageState: { cookies: [goodState.cookies[1]] } })).res.status, 400); // nothing on-domain
  assert.equal((await post(deps(), auth, 'not json')).res.status, 400);
  const big = { storageState: { cookies: [{ ...goodState.cookies[0], value: 'a'.repeat(MAX_HANDOFF_BYTES) }] } };
  assert.equal((await post(deps(), auth, big)).res.status, 413);
  const res = fakeRes();
  await handleOps(fakeReq({ method: 'GET' }), res, '/ops/handoff/doordash', deps());
  assert.equal(res.status, 405);
});

test('domain filtering: registrable domain from loginUrl plus handoffDomains', () => {
  assert.equal(registrableDomain('https://merchant-portal.doordash.com/x'), 'doordash.com');
  assert.equal(registrableDomain('.auth.uber.com'), 'uber.com');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('localhost'), null);
  assert.deepEqual(allowedDomains(adapters.ubereats), ['ubereats.com', 'uber.com']);
  const allowed = allowedDomains(adapters.doordash);
  assert.ok(domainAllowed('.doordash.com', allowed));
  assert.ok(domainAllowed('identity.doordash.com', allowed));
  assert.ok(!domainAllowed('notdoordash.com', allowed));
  assert.ok(!domainAllowed('doordash.com.evil.com', allowed));
  assert.ok(!domainAllowed('', allowed));
});

test('storageState validation', () => {
  const allowed = ['doordash.com'];
  assert.throws(() => validateStorageState(null, allowed), /object/);
  assert.throws(() => validateStorageState({ cookies: {} }, allowed), /array/);
  assert.throws(() => validateStorageState({ cookies: [{ name: 'a', domain: 'doordash.com' }] }, allowed), /string name, value, domain/);
  assert.throws(() => validateStorageState({ cookies: [{ name: 'a', value: 'b', domain: 'doordash.com', sameSite: 'lax' }] }, allowed), /sameSite/);
  assert.throws(() => validateStorageState({ cookies: [{ name: 'a', value: 'b', domain: 'doordash.com', expires: 'soon' }] }, allowed), /expires/);
  assert.throws(() => validateStorageState({ cookies: [goodState.cookies[0]], origins: [{ origin: 'javascript:alert(1)' }] }, allowed), /http/);
  const { storageState } = validateStorageState({ cookies: [{ name: 'a', value: 'b', domain: 'www.doordash.com' }] }, allowed);
  assert.deepEqual(storageState.cookies[0], { name: 'a', value: 'b', domain: 'www.doordash.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' });
  assert.deepEqual(storageState.origins, []);
});

test('GET /ops/handoff/vendors lists session vendors with domains (token required)', async () => {
  let res = fakeRes();
  await handleOps(fakeReq({ method: 'GET' }), res, '/ops/handoff/vendors', deps());
  assert.equal(res.status, 401);
  res = fakeRes();
  await handleOps(fakeReq({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } }), res, '/ops/handoff/vendors', deps());
  assert.equal(res.status, 200);
  assert.deepEqual(res.json().vendors.map(v => [v.id, v.domains]), [['doordash', ['doordash.com']], ['ubereats', ['ubereats.com', 'uber.com']]]);
});

test('status + sync routes; non-ops routes are not handled', async () => {
  let res = fakeRes();
  await handleOps(fakeReq({ method: 'GET', url: '/ops/status' }), res, '/ops/status', { status: async () => ({ state: 'ok', vendors: [] }) });
  assert.deepEqual(res.json(), { state: 'ok', vendors: [] });

  const calls = [];
  const runner = { runVendor: async (id, o) => { calls.push(['one', id, o]); return { vendor: id, ok: true }; }, runAll: async o => { calls.push(['all', o]); return { at: 't', ok: true, results: [], inbox: { ok: true, results: [] } }; } };
  res = fakeRes();
  await handleOps(fakeReq({ url: '/ops/sync?vendor=doordash' }), res, '/ops/sync', { runner });
  assert.deepEqual(res.json(), { collect: { vendor: 'doordash', ok: true } });
  res = fakeRes();
  await handleOps(fakeReq({ url: '/ops/sync?from=2026-11-01&through=2026-11-02' }), res, '/ops/sync', { runner, inbox: { sweepInbox: async () => assert.fail('runAll already swept the inbox') } });
  assert.equal(res.json().collect.ok, true);
  assert.deepEqual(calls[1], ['all', { range: { from: '2026-11-01', through: '2026-11-02' } }]);
  res = fakeRes();
  await handleOps(fakeReq({ url: '/ops/sync?from=nov' }), res, '/ops/sync', { runner });
  assert.equal(res.status, 400);

  assert.equal(await handleOps(fakeReq({ method: 'GET', url: '/status' }), fakeRes(), '/status', {}), false);
  res = fakeRes();
  assert.equal(await handleOps(fakeReq({ method: 'GET', url: '/ops/nope' }), res, '/ops/nope', {}), true);
  assert.equal(res.status, 404);
});
