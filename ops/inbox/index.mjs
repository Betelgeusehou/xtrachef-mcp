// Inbox lane: pull vendor report emails from the ops Gmail label, hand each attachment
// (or the HTML/text body when there is none) to the first adapter that claims it.
//
// Called by the core runner, which persists each item's `result` and records runs itself.
// Pass {persist: true} to upsert + recordRun here instead (standalone use).
//
// Returns [{vendor, mode, messageId, file, records, result?, ok, error?}]
//   - unclaimed files: {vendor: null, ok: false, error: 'no adapter matched'}
//   - already-ingested files (ledger) are omitted.
import { findMessages, getAttachment, markProcessed, gmailLabel } from './gmail.mjs';
import { readLedger, hasFile, addFiles, sha256, readState, writeState } from './ledger.mjs';
import { loadAdapters, expand, routeFile, persistItems } from './route.mjs';
import { sweepDrive } from './drive.mjs';

export { findMessages, getAttachment, markProcessed, waitForEmailCode } from './gmail.mjs';
export { sweepDrive } from './drive.mjs';

const LOOKBACK_DAYS = 14;
const OVERLAP_MS = 60 * 60 * 1000; // re-scan the last hour; ledger dedupes

function bodyCandidate(m) {
  if (m.bodyHtml) return { filename: 'body.html', ledgerName: 'body.html', buffer: Buffer.from(m.bodyHtml, 'utf8'), mimeType: 'text/html' };
  if (m.bodyText) return { filename: 'body.txt', ledgerName: 'body.txt', buffer: Buffer.from(m.bodyText, 'utf8'), mimeType: 'text/plain' };
  return null;
}

export async function sweepInbox({ adapters, exec, since, label = gmailLabel(), persist = false, max = 200, drive = true } = {}) {
  const startedAt = new Date().toISOString();
  adapters = await loadAdapters(adapters);
  const state = readState();
  const after = since ?? (state.cursor ? Date.parse(state.cursor) - OVERLAP_MS : Date.now() - LOOKBACK_DAYS * 86400000);
  const messages = await findMessages({ label, after, max }, { exec });
  const done = readLedger().messages;
  const items = [];

  for (const m of messages) {
    if (done[m.id]) continue;
    const meta = { from: m.from, subject: m.subject, receivedAt: m.receivedAt, messageId: m.id };
    const routed = [];
    const sources = m.attachments.length ? m.attachments : [null];
    for (const att of sources) {
      let cands;
      try {
        if (att) cands = expand(att.filename, await getAttachment(m, att, { exec }), att.mimeType);
        else { const b = bodyCandidate(m); cands = b ? [b] : []; }
      } catch (e) {
        routed.push({ vendor: null, mode: 'inbox', messageId: m.id, file: att?.filename || 'body', records: 0, ok: false, error: `download failed: ${e?.message || String(e)}`.slice(0, 500) });
        continue;
      }
      for (const c of cands) {
        if (hasFile(m.id, c.ledgerName, sha256(c.buffer))) continue;
        const it = await routeFile(c, meta, adapters, { mode: 'inbox', modes: ['inbox'] });
        routed.push(it);
      }
    }
    if (persist) await persistItems(routed, { mode: 'inbox', startedAt });
    const okFiles = routed.filter(i => i.ok).map(i => ({ filename: i.file, sha256: i.sha256, vendor: i.vendor, records: i.records }));
    if (routed.length && routed.every(i => i.ok)) {
      const mark = await markProcessed(m.id, { exec, label, files: okFiles });
      if (!mark.labeled) for (const i of routed) i.labelError = mark.error;
    } else {
      addFiles(m.id, okFiles); // keep unclaimed/failed files retryable
    }
    items.push(...routed);
  }

  writeState({ ...readState(), cursor: startedAt, lastSweepAt: startedAt, lastCount: items.length });

  if (drive && process.env.OPS_DRIVE_FOLDER_ID) {
    try {
      items.push(...await sweepDrive({ folderId: process.env.OPS_DRIVE_FOLDER_ID, adapters, exec, persist }));
    } catch (e) {
      items.push({ vendor: null, mode: 'drive', messageId: null, file: null, records: 0, ok: false, error: `drive sweep failed: ${e?.message || String(e)}`.slice(0, 500) });
    }
  }
  return items;
}
