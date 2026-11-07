// Drive lane: files dropped into a Drive folder (OPS_DRIVE_FOLDER_ID) are routed to
// vendor adapters exactly like email attachments. Same Composio slugs as src/sync.js
// and src/pmix.js (GOOGLEDRIVE_FIND_FILE, GOOGLEDRIVE_DOWNLOAD_FILE -> downloaded_file_content.s3url).
import { readLedger, hasFile, addFiles, sha256 } from './ledger.mjs';
import { loadAdapters, expand, routeFile, persistItems } from './route.mjs';
import { readCapped, checkSize } from './limits.mjs';

export const DRIVE = { FIND_FILE: 'GOOGLEDRIVE_FIND_FILE', DOWNLOAD_FILE: 'GOOGLEDRIVE_DOWNLOAD_FILE' };

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Native Google files must be exported; pick a format adapters can parse.
const EXPORT = {
  'application/vnd.google-apps.spreadsheet': ['text/csv', '.csv'],
  'application/vnd.google-apps.document': ['text/html', '.html'],
};

async function defaultExec(tools) {
  const { composioExecute } = await import('../../src/sync.js');
  return composioExecute(tools);
}
async function call(exec, slug, args) {
  const account = env('OPS_DRIVE_ACCOUNT', env('XTRACHEF_DRIVE_ACCOUNT', ''));
  const [data] = await (exec || defaultExec)([{ tool_slug: slug, ...(account ? { account } : {}), arguments: args }]);
  return data;
}

export async function listFolder(folderId, { exec, max = 200 } = {}) {
  const out = [];
  let pageToken;
  do {
    const data = await call(exec, DRIVE.FIND_FILE, {
      folder_id: folderId, q: 'trashed = false', orderBy: 'createdTime desc', pageSize: Math.min(100, max),
      fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime)',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of data?.files || []) if (f.mimeType !== FOLDER_MIME) out.push(f);
    pageToken = data?.nextPageToken;
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

export async function downloadFile(file, { exec } = {}) {
  const exp = EXPORT[file.mimeType];
  if (!exp && file.size !== undefined && file.size !== null && file.size !== '') checkSize(`Drive file ${file.name}`, Number(file.size));
  const data = await call(exec, DRIVE.DOWNLOAD_FILE, { fileId: file.id, ...(exp ? { mime_type: exp[0] } : {}) });
  const url = data?.downloaded_file_content?.s3url || data?.downloaded_file_content?.url;
  if (!url) throw Error(`Drive download of ${file.name} returned no file link`);
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw Error(`Downloading ${file.name} from Drive returned HTTP ${res.status}`);
  return readCapped(res, `Drive file ${file.name}`);
}

// Version key: a re-uploaded/edited file gets a new key and is re-ingested.
const sourceId = f => `drive:${f.id}@${f.md5Checksum || f.modifiedTime || f.createdTime || ''}`;

export async function sweepDrive({ folderId = env('OPS_DRIVE_FOLDER_ID', ''), adapters, exec, persist = false, max = 200 } = {}) {
  if (!folderId) throw Error('sweepDrive: no folderId (set OPS_DRIVE_FOLDER_ID)');
  const startedAt = new Date().toISOString();
  adapters = await loadAdapters(adapters);
  const files = await listFolder(folderId, { exec, max });
  const done = readLedger().messages;
  const items = [];
  for (const f of files) {
    const id = sourceId(f);
    if (done[id]) continue;
    const exp = EXPORT[f.mimeType];
    const filename = exp && !f.name.toLowerCase().endsWith(exp[1]) ? f.name + exp[1] : f.name;
    const meta = { from: 'drive', subject: f.name, receivedAt: f.createdTime || f.modifiedTime || null, messageId: id, driveFileId: f.id };
    let cands;
    try {
      const buf = await downloadFile(f, { exec });
      cands = expand(filename, buf, exp ? exp[0] : f.mimeType);
    } catch (e) {
      items.push({ vendor: null, mode: 'drive', messageId: id, file: filename, records: 0, ok: false, error: `download failed: ${e?.message || String(e)}`.slice(0, 500) });
      continue;
    }
    const routed = [];
    for (const c of cands) {
      if (hasFile(id, c.ledgerName, sha256(c.buffer))) continue;
      routed.push(await routeFile(c, meta, adapters, { mode: 'drive', modes: ['drive', 'inbox'] }));
    }
    if (persist) await persistItems(routed, { mode: 'drive', startedAt });
    const okFiles = routed.filter(i => i.ok).map(i => ({ filename: i.file, sha256: i.sha256, vendor: i.vendor, records: i.records }));
    addFiles(id, okFiles, { done: routed.every(i => i.ok) });
    items.push(...routed);
  }
  return items;
}
