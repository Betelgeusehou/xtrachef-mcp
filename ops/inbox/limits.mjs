// Download size cap shared by the Gmail and Drive lanes. OPS_MAX_FILE_BYTES overrides the 25MB default.
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export function maxFileBytes() {
  const n = Number(process.env.OPS_MAX_FILE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES;
}
const tooBig = (label, n, max) =>
  Error(`${label} is too large (${n === null ? 'over limit' : `${n} bytes`}; limit ${max} bytes, set OPS_MAX_FILE_BYTES to raise)`);

export function checkSize(label, n, max = maxFileBytes()) {
  if (n > max) throw tooBig(label, n, max);
}

// Read a fetch Response body: reject on content-length, and stop the stream once it passes the cap.
export async function readCapped(res, label, max = maxFileBytes()) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    try { await res.body?.cancel(); } catch {}
    throw tooBig(label, declared, max);
  }
  if (!res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    checkSize(label, buf.length, max);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      try { await reader.cancel(); } catch {}
      throw tooBig(label, null, max);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, n);
}
