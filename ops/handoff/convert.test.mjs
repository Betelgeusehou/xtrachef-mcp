import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeToPlaywright, toStorageState, likelySignedIn, fingerprint, msUntil, normalizeBase, DEFAULT_VENDORS } from './extension/convert.js';
import { validateStorageState, allowedDomains } from '../http.mjs';

const chromeCookie = o => ({ name: 'sid', value: 'v', domain: '.doordash.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', session: false, expirationDate: 1893456000.75, storeId: '0', ...o });

test('chrome cookie -> Playwright cookie: sameSite mapping, expires, domain', () => {
  assert.deepEqual(chromeToPlaywright(chromeCookie()), { name: 'sid', value: 'v', domain: '.doordash.com', path: '/', expires: 1893456000, httpOnly: true, secure: true, sameSite: 'None' });
  assert.equal(chromeToPlaywright(chromeCookie({ sameSite: 'lax' })).sameSite, 'Lax');
  assert.equal(chromeToPlaywright(chromeCookie({ sameSite: 'strict' })).sameSite, 'Strict');
  assert.equal(chromeToPlaywright(chromeCookie({ sameSite: 'unspecified' })).sameSite, 'Lax');
  assert.equal(chromeToPlaywright(chromeCookie({ sameSite: 'no_restriction', secure: false })).sameSite, 'Lax');
  const s = chromeToPlaywright(chromeCookie({ session: true, expirationDate: undefined }));
  assert.equal(s.expires, -1);
  assert.equal(chromeToPlaywright(chromeCookie({ hostOnly: true, domain: 'merchant-portal.doordash.com' })).domain, 'merchant-portal.doordash.com');
  assert.equal(chromeToPlaywright(chromeCookie({ hostOnly: false, domain: 'doordash.com' })).domain, '.doordash.com');
});

test('toStorageState dedupes across domain queries, skips partitioned cookies, passes server validation', () => {
  const a = chromeCookie(), b = chromeCookie({ name: 'csrf', httpOnly: false, sameSite: 'lax' });
  const state = toStorageState([[a, b], [a], [chromeCookie({ name: 'chips', partitionKey: { topLevelSite: 'https://x.com' } })]]);
  assert.deepEqual(state.cookies.map(c => c.name), ['sid', 'csrf']);
  assert.deepEqual(state.origins, []);
  const dd = DEFAULT_VENDORS.find(v => v.id === 'doordash');
  const { storageState, dropped } = validateStorageState(state, allowedDomains({ loginUrl: dd.loginUrl }));
  assert.equal(storageState.cookies.length, 2);
  assert.equal(dropped, 0);
});

test('likelySignedIn needs a long-lived httpOnly non-bot-check cookie', () => {
  const now = 1_800_000_000_000;
  const mk = cs => ({ cookies: cs, origins: [] });
  assert.equal(likelySignedIn(mk([{ name: '__cf_bm', httpOnly: true, expires: now / 1000 + 9e6 }]), now), false);
  assert.equal(likelySignedIn(mk([{ name: '_ga', httpOnly: false, expires: now / 1000 + 9e6 }]), now), false);
  assert.equal(likelySignedIn(mk([{ name: 'sid', httpOnly: true, expires: now / 1000 + 600 }]), now), false);
  assert.equal(likelySignedIn(mk([{ name: 'sid', httpOnly: true, expires: -1 }]), now), true);
  assert.equal(likelySignedIn(mk([{ name: 'sid', httpOnly: true, expires: now / 1000 + 9e6 }]), now), true);
});

test('fingerprint ignores non-httpOnly churn and order', async () => {
  const x = { name: 'sid', value: '1', domain: '.a.com', path: '/', httpOnly: true };
  const y = { name: 'ga', value: 'r1', domain: '.a.com', path: '/', httpOnly: false };
  const z = { name: 'tok', value: '2', domain: '.a.com', path: '/', httpOnly: true };
  const f1 = await fingerprint({ cookies: [x, y, z] });
  const f2 = await fingerprint({ cookies: [z, { ...y, value: 'r2' }, x] });
  assert.equal(f1, f2);
  assert.notEqual(f1, await fingerprint({ cookies: [{ ...x, value: '9' }, z] }));
});

test('msUntil schedules the next 3:30 local, normalizeBase cleans URLs', () => {
  const at = (h, m) => { const d = new Date(2026, 10, 7, h, m, 0, 0); return d; };
  assert.equal(msUntil(3, 30, at(3, 0)), 30 * 60000);
  assert.equal(msUntil(3, 30, at(3, 30)), 24 * 3600000);
  assert.equal(msUntil(3, 30, at(4, 0)), 23.5 * 3600000);
  assert.equal(normalizeBase(' https://svc.up.railway.app/abc123/mcp '), 'https://svc.up.railway.app/abc123');
  assert.equal(normalizeBase('https://svc.up.railway.app/abc123/'), 'https://svc.up.railway.app/abc123');
  assert.equal(normalizeBase('http://localhost:3999/s'), 'http://localhost:3999/s');
  assert.throws(() => normalizeBase('http://svc.up.railway.app/abc'), /https/);
});
