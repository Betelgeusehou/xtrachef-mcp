import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-vault-'));
process.env.OPS_DATA_DIR = dir;
const KEY = crypto.randomBytes(32).toString('base64');
process.env.OPS_VAULT_KEY = KEY;
const v = await import('./vault.mjs');

test('creds round-trip and are encrypted at rest', () => {
  v.setCreds('doordash', { username: 'chris@example.com', password: 'hunter2-secret' });
  assert.deepEqual(v.getCreds('doordash'), { username: 'chris@example.com', password: 'hunter2-secret' });
  const raw = fs.readFileSync(path.join(dir, 'vault.enc'), 'utf8');
  assert.ok(!raw.includes('hunter2'));
  assert.equal(v.getCreds('nope'), null);
  assert.equal(v.deleteCreds('doordash'), true);
  assert.equal(v.getCreds('doordash'), null);
});

test('session round-trip, list has no secrets, clear', () => {
  const state = { cookies: [{ name: 'sid', value: 'COOKIEVALUE123' }], origins: [] };
  v.saveSession('uber-eats', state, { source: 'handoff' });
  const s = v.loadSession('uber-eats');
  assert.deepEqual(s.storageState, state);
  assert.equal(s.source, 'handoff');
  assert.ok(Date.parse(s.savedAt));
  assert.ok(!fs.readFileSync(path.join(dir, 'sessions', 'uber-eats.enc'), 'utf8').includes('COOKIEVALUE123'));
  v.setCreds('homebase', { username: 'u', password: 'PASSWORDXYZ' });
  const list = v.listVault();
  assert.ok(!JSON.stringify(list).includes('COOKIEVALUE123'));
  assert.ok(!JSON.stringify(list).includes('PASSWORDXYZ'));
  assert.deepEqual(list.find(x => x.vendor === 'uber-eats'), { vendor: 'uber-eats', hasCreds: false, hasSession: true, sessionSavedAt: s.savedAt, sessionSource: 'handoff' });
  assert.equal(list.find(x => x.vendor === 'homebase').hasCreds, true);
  assert.equal(v.clearSession('uber-eats'), true);
  assert.equal(v.loadSession('uber-eats'), null);
});

test('wrong key fails clearly; missing / short key throws', () => {
  v.setCreds('grubhub', { password: 'x' });
  process.env.OPS_VAULT_KEY = crypto.randomBytes(32).toString('base64');
  assert.throws(() => v.getCreds('grubhub'), /OPS_VAULT_KEY does not match/);
  process.env.OPS_VAULT_KEY = Buffer.alloc(16).toString('base64');
  assert.throws(() => v.getCreds('grubhub'), /exactly 32 bytes/);
  delete process.env.OPS_VAULT_KEY;
  assert.throws(() => v.getCreds('grubhub'), /OPS_VAULT_KEY is not set/);
  process.env.OPS_VAULT_KEY = KEY;
  assert.deepEqual(v.getCreds('grubhub'), { password: 'x' });
});

test('env bootstrap wins over vault and needs no key', () => {
  v.setCreds('toast-payroll', { username: 'vault' });
  process.env.OPS_CREDS_TOAST_PAYROLL = JSON.stringify({ username: 'env', totpSecret: 'JBSWY3DPEHPK3PXP' });
  assert.equal(v.getCreds('toast-payroll').username, 'env');
  delete process.env.OPS_VAULT_KEY;
  assert.equal(v.getCreds('toast-payroll').username, 'env');
  process.env.OPS_VAULT_KEY = KEY;
  assert.equal(v.envVarFor('toast-payroll'), 'OPS_CREDS_TOAST_PAYROLL');
  assert.ok(v.listVault().find(x => x.vendor === 'toast-payroll').hasCreds);
  process.env.OPS_CREDS_BAD = 'not json';
  assert.throws(() => v.getCreds('bad'), /not a JSON object/);
  delete process.env.OPS_CREDS_BAD;
  delete process.env.OPS_CREDS_TOAST_PAYROLL;
  assert.equal(v.getCreds('toast-payroll').username, 'vault');
});

test('rejects path-traversal vendor ids', () => {
  assert.throws(() => v.saveSession('../x', {}), /Invalid vendor id/);
});

test('ciphertext is bound to its context (AAD); mismatch fails clearly', () => {
  const key = Buffer.from(KEY, 'base64');
  const enc = v.encrypt({ a: 1 }, key, 'session:doordash');
  assert.deepEqual(v.decrypt(enc, key, 'session:doordash'), { a: 1 });
  assert.throws(() => v.decrypt(enc, key, 'session:grubhub'), /written for context "session:doordash", expected "session:grubhub"/);
  assert.throws(() => v.decrypt(enc, key, 'vault'), /expected "vault"/);
  // Rewriting the envelope's context label does not get past GCM authentication.
  const parts = enc.split('.');
  parts[1] = Buffer.from('session:grubhub').toString('base64url');
  assert.throws(() => v.decrypt(parts.join('.'), key, 'session:grubhub'), /does not match|altered/);
  // Swapping one vendor's session file onto another vendor is rejected.
  v.saveSession('doordash', { cookies: [], origins: [] }, { source: 't' });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'sessions', 'doordash.enc'), path.join(dir, 'sessions', 'grubhub.enc'));
  assert.throws(() => v.loadSession('grubhub'), /context "session:doordash", expected "session:grubhub"/);
  // A session file can't be dropped in as the vault either.
  const vaultPath = path.join(dir, 'vault.enc');
  const saved = fs.readFileSync(vaultPath, 'utf8');
  fs.copyFileSync(path.join(dir, 'sessions', 'doordash.enc'), vaultPath);
  assert.throws(() => v.getCreds('grubhub'), /expected "vault"/);
  fs.writeFileSync(vaultPath, saved);
  v.clearSession('doordash'); v.clearSession('grubhub');
});

test('rejects auth tags that are not 16 bytes', () => {
  const key = Buffer.from(KEY, 'base64');
  const parts = v.encrypt({ a: 1 }, key).split('.');
  parts[3] = Buffer.from(parts[3], 'base64').subarray(0, 4).toString('base64');
  assert.throws(() => v.decrypt(parts.join('.'), key), /invalid auth tag \(4 bytes, expected 16\)/);
});
