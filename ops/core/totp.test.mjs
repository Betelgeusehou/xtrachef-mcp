import test from 'node:test';
import assert from 'node:assert/strict';
import { totp, base32Decode } from './totp.mjs';

// RFC 6238 Appendix B, SHA1 seed "12345678901234567890" (base32 below), 8 digits.
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];

test('base32 decodes the RFC seed (spaces/lowercase ok)', () => {
  assert.equal(base32Decode(SEED).toString(), '12345678901234567890');
  assert.equal(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString(), '12345678901234567890');
});

test('RFC 6238 SHA1 vectors', () => {
  for (const [t, code] of VECTORS) assert.equal(totp(SEED, t * 1000, { digits: 8 }), code, `t=${t}`);
});

test('6-digit default is the last 6 of the 8-digit code', () => {
  assert.equal(totp(SEED, 59000), '287082');
});

test('bad secret throws', () => {
  assert.throws(() => totp('not!base32'), /base32/);
  assert.throws(() => totp(''), /empty/);
});
