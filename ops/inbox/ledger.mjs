// Local processed-file ledger for the inbox and Drive lanes. Source of truth for
// "already ingested" (Gmail labels can fail to apply). Lives in opsDir()/inbox-ledger.json.
// Entry key = `${messageId}|${filename}|${hash}` (sha256 of the bytes; Drive may also
// pre-record md5Checksum so unchanged files are skipped without downloading).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { opsDir } from '../core/store.mjs';

const MAX_ENTRIES = 20000;
export const ledgerFile = () => path.join(opsDir(), 'inbox-ledger.json');
export const stateFile = () => path.join(opsDir(), 'inbox-state.json');
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
export const fileKey = (messageId, filename, hash) => `${messageId}|${filename}|${hash}`;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 1));
  fs.renameSync(file + '.tmp', file);
}

export function readLedger() {
  const l = readJson(ledgerFile(), null);
  return { files: l?.files || {}, messages: l?.messages || {} };
}

function save(l) {
  const keys = Object.keys(l.files);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => String(l.files[a].at).localeCompare(String(l.files[b].at)));
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete l.files[k];
  }
  const mkeys = Object.keys(l.messages);
  if (mkeys.length > MAX_ENTRIES) {
    mkeys.sort((a, b) => String(l.messages[a]).localeCompare(String(l.messages[b])));
    for (const k of mkeys.slice(0, mkeys.length - MAX_ENTRIES)) delete l.messages[k];
  }
  writeJson(ledgerFile(), l);
}

export const hasFile = (messageId, filename, hash) => Boolean(readLedger().files[fileKey(messageId, filename, hash)]);
export const isMessageDone = messageId => Boolean(readLedger().messages[messageId]);

// files: [{filename, sha256, vendor, records}]
export function addFiles(messageId, files = [], { done = false } = {}) {
  const l = readLedger(), at = new Date().toISOString();
  for (const f of files) {
    if (!f?.filename || !f?.sha256) continue;
    l.files[fileKey(messageId, f.filename, f.sha256)] = { messageId, filename: f.filename, vendor: f.vendor ?? null, records: f.records ?? 0, at };
  }
  if (done) l.messages[messageId] = at;
  save(l);
}

export const readState = () => readJson(stateFile(), {});
export const writeState = s => writeJson(stateFile(), s);
