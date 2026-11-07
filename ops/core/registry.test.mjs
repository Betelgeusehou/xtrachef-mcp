import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters, getAdapter, validateAdapter } from './registry.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-vendors-'));
const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
w('a-good.mjs', `export default { id: 'good-one', name: 'Good', domain: 'delivery', modes: ['session','inbox'], kinds: ['delivery_orders'], loginUrl: 'https://x.test/', async isLoggedIn(){return true}, async collect(){return {}}, matchFile(){return false}, parseFile(){return {}} };`);
w('badkind.mjs', `export default { id: 'bad-kind', domain: 'delivery', modes: ['api'], kinds: ['tacos'], async collect(){} };`);
w('nologin.mjs', `export default { id: 'no-login', domain: 'labor', modes: ['login'], kinds: [], loginUrl: 'https://x.test/', async isLoggedIn(){}, async collect(){} };`);
w('broken.mjs', `export default {{{`);
w('_helper.mjs', `throw new Error('should not load');`);
w('a-good.test.mjs', `throw new Error('should not load');`);
w('z-dupe.mjs', `export default { id: 'good-one', domain: 'delivery', modes: ['api'], kinds: [], async collect(){} };`);

test('loads valid adapters, skips tests/underscore files, reports invalid ones', async () => {
  const list = await adapters({ dir });
  assert.deepEqual(list.map(a => a.id), ['good-one']);
  const errs = Object.fromEntries(list.errors.map(e => [e.file, e.problems.join('|')]));
  assert.match(errs['badkind.mjs'], /unknown kind tacos/);
  assert.match(errs['nologin.mjs'], /login\(ctx\)/);
  assert.match(errs['broken.mjs'], /import failed/);
  assert.match(errs['z-dupe.mjs'], /duplicate id/);
  assert.ok(!('_helper.mjs' in errs) && !('a-good.test.mjs' in errs));
});

test('getAdapter honours OPS_VENDORS_DIR', async () => {
  process.env.OPS_VENDORS_DIR = dir;
  assert.equal((await getAdapter('good-one', { reload: true })).name, 'Good');
  assert.equal(await getAdapter('missing'), null);
  delete process.env.OPS_VENDORS_DIR;
});

test('validateAdapter catches contract errors', () => {
  assert.ok(validateAdapter({ id: 'Bad Id', domain: 'x', modes: [], kinds: 'no' }).length >= 4);
  assert.deepEqual(validateAdapter({ id: 'ok', domain: 'banking', modes: ['inbox'], kinds: ['bank_transactions'], matchFile() {}, parseFile() {} }), []);
});
