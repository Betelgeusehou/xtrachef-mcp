// Minimal in-memory ZIP reader: stored (0) and deflate (8) entries, no Zip64, no encryption.
// Some vendors email their CSV exports zipped.
import zlib from 'node:zlib';

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

// Office/OpenDocument files are zip containers too; they are files to hand to an adapter,
// never archives to expand. Decide by name/MIME only, never by sniffing the PK header.
const CONTAINER_EXT = /\.(xlsx|xlsm|xlsb|xltx|xltm|docx|docm|dotx|pptx|pptm|ods|odt|odp)$/i;
const ZIP_MIME = /^application\/(zip|x-zip-compressed)\s*(;|$)/i;
export const isZip = (_buf, filename = '', mimeType = '') => {
  if (CONTAINER_EXT.test(filename || '')) return false;
  return /\.zip$/i.test(filename || '') || ZIP_MIME.test(String(mimeType || '').trim());
};

const MB = 1024 * 1024;
export const MAX_ENTRY_BYTES = 50 * MB;
export const MAX_TOTAL_BYTES = 100 * MB;

// -> [{name, data: Buffer}] for every file entry (directories skipped).
// Zip-bomb guards: entries declaring more than maxEntryBytes are rejected before inflating,
// inflate output is capped at the declared size, and the archive's total output is capped.
export function unzip(buf, { maxEntryBytes = MAX_ENTRY_BYTES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
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
  let total = 0;
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
    if (size > maxEntryBytes) throw Error(`Zip entry ${name} is too large (${size} bytes uncompressed; limit ${maxEntryBytes})`);
    if (total + size > maxTotalBytes) throw Error(`Zip archive expands past the ${maxTotalBytes}-byte limit (at entry ${name})`);
    total += size;
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }); }
      catch (e) {
        if (e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw Error(`Zip entry ${name} inflates past its declared size (${size} bytes)`);
        throw e;
      }
    }
    else throw Error(`Zip entry ${name} uses unsupported compression method ${method}`);
    if (data.length !== size) throw Error(`Zip entry ${name} size mismatch`);
    out.push({ name, data });
  }
  return out;
}
