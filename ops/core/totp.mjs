// RFC 6238 TOTP (HMAC-SHA1) over a base32 secret, node:crypto only.
import crypto from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean) throw Error('TOTP secret is empty');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) throw Error('TOTP secret is not valid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totp(base32Secret, now = Date.now(), { digits = 6, period = 30 } = {}) {
  return hotp(base32Decode(base32Secret), Math.floor(now / 1000 / period), digits);
}
