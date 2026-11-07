// Minimal in-memory ZIP reader: stored (0) and deflate (8) entries, no Zip64, no encryption.
// Some vendors email their CSV exports zipped.
import zlib from 'node:zlib';

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

export const isZip = (buf, filename = '', mimeType = '') =>
  /\.zip$/i.test(filename) || /zip/i.test(mimeType) || (buf?.length >= 4 && buf.readUInt32LE(0) === LOC);

// -> [{name, data: Buffer}] for every file entry (directories skipped).
export function unzip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw Error('Not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw Error('Zip64 archives are not supported');
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN) throw Error('Corrupt zip central directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw Error(`Zip entry ${name} is encrypted`);
    if (buf.readUInt32LE(local) !== LOC) throw Error(`Corrupt zip local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw Error(`Zip entry ${name} uses unsupported compression method ${method}`);
    if (data.length !== size) throw Error(`Zip entry ${name} size mismatch`);
    out.push({ name, data });
  }
  return out;
}
