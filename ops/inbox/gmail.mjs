// Gmail through Composio: find vendor report emails in the ops label, download
// attachments, mark messages processed, and read emailed MFA codes.
//
// `exec` has the same signature as src/sync.js composioExecute(tools) -> data[]
// (one `response.data` per tool call). It defaults to composioExecute; tests inject a fake.
import { addFiles } from './ledger.mjs';

// Composio GMAIL toolkit slugs + argument names. Verified 2026-11-07 against Composio's
// live tool schemas (COMPOSIO_GET_TOOL_SCHEMAS, input + output schema); toolkit docs:
// https://docs.composio.dev/toolkits/gmail
//   GMAIL_FETCH_EMAILS {query, label_ids[], max_results<=500, page_token, include_payload, verbose}
//     -> data {messages:[{messageId, threadId, sender, subject, messageTimestamp, messageText,
//              attachmentList[], payload, labelIds, preview}], nextPageToken, resultSizeEstimate}
//     (body + attachmentList need verbose=true; payload bodies are base64url)
//   GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID {message_id, format:'full'} -> data = one message (same shape)
//   GMAIL_GET_ATTACHMENT {message_id, attachment_id, file_name} -> data {file:{name, mimetype, s3url}}
//   GMAIL_LIST_LABELS {} -> data {labels:[{id, name, type}]}
//   GMAIL_CREATE_LABEL {label_name} -> data {id, name}  (creates missing parents for "a/b")
//   GMAIL_ADD_LABEL_TO_EMAIL {message_id, add_label_ids[], remove_label_ids[]} (label IDs, not names)
export const GMAIL = {
  FETCH_EMAILS: 'GMAIL_FETCH_EMAILS',
  FETCH_MESSAGE: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
  GET_ATTACHMENT: 'GMAIL_GET_ATTACHMENT',
  LIST_LABELS: 'GMAIL_LIST_LABELS',
  CREATE_LABEL: 'GMAIL_CREATE_LABEL',
  ADD_LABEL: 'GMAIL_ADD_LABEL_TO_EMAIL',
};

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
export const gmailLabel = () => env('OPS_GMAIL_LABEL', 'ops-reports');
export const processedLabel = (label = gmailLabel()) => `${label}/processed`;

export async function defaultExec(tools) {
  const { composioExecute } = await import('../../src/sync.js');
  return composioExecute(tools);
}

async function call(exec, slug, args) {
  const account = env('OPS_GMAIL_ACCOUNT', '');
  const [data] = await (exec || defaultExec)([{ tool_slug: slug, ...(account ? { account } : {}), arguments: args }]);
  return data;
}

// Gmail search names labels with spaces and slashes as hyphens: "ops-reports/processed" -> "ops-reports-processed".
const searchLabel = name => `"${String(name).replace(/[\s/]+/g, '-').replace(/"/g, '')}"`;

const b64 = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function walkParts(part, fn) {
  if (!part) return;
  fn(part);
  for (const p of part.parts || []) walkParts(p, fn);
}

export function stripHtml(html = '') {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

const header = (payload, name) =>
  (payload?.headers || []).find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value;

function toIso(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  const n = Number(ts);
  const d = Number.isFinite(n) && /^\d+$/.test(String(ts)) ? new Date(n) : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Normalize one Composio message object into the lane's message shape.
export function parseMessage(m) {
  const payload = m.payload || null;
  let bodyText = '', bodyHtml = '';
  const fromParts = [];
  walkParts(payload, p => {
    const mt = String(p.mimeType || '').toLowerCase();
    const aid = p.body?.attachmentId;
    if (p.filename) {
      fromParts.push({
        attachmentId: aid || null, filename: p.filename, mimeType: p.mimeType || 'application/octet-stream',
        size: Number(p.body?.size ?? 0), ...(p.body?.data && !aid ? { data: p.body.data } : {}),
      });
      return;
    }
    if (p.body?.data) {
      if (mt === 'text/html' && !bodyHtml) bodyHtml = b64(p.body.data).toString('utf8');
      else if (mt === 'text/plain' && !bodyText) bodyText = b64(p.body.data).toString('utf8');
    }
  });
  if (!bodyText && m.messageText) bodyText = String(m.messageText);
  if (!bodyHtml && /<html|<body|<table|<div/i.test(bodyText)) bodyHtml = bodyText;

  const attachments = [];
  const seen = new Set();
  for (const a of [...(m.attachmentList || []), ...fromParts]) {
    const att = {
      attachmentId: a.attachmentId ?? a.attachment_id ?? a.id ?? null,
      filename: a.filename ?? a.fileName ?? a.name ?? '',
      mimeType: a.mimeType ?? a.mime_type ?? a.mimetype ?? 'application/octet-stream',
      size: Number(a.size ?? a.body?.size ?? 0),
      ...(a.data ? { data: a.data } : {}),
    };
    if (!att.filename) continue;
    const k = att.attachmentId || `name:${att.filename}`;
    if (seen.has(k) || seen.has(`name:${att.filename}`)) continue;
    seen.add(k); seen.add(`name:${att.filename}`);
    attachments.push(att);
  }

  return {
    id: m.messageId ?? m.id,
    threadId: m.threadId ?? null,
    from: m.sender ?? header(payload, 'From') ?? '',
    subject: m.subject ?? header(payload, 'Subject') ?? m.preview?.subject ?? '',
    receivedAt: toIso(m.messageTimestamp ?? m.internalDate ?? header(payload, 'Date')),
    snippet: m.snippet ?? m.preview?.body ?? '',
    bodyText,
    bodyHtml,
    labelIds: m.labelIds || [],
    attachments,
  };
}

// Find messages. `label` = display name (null searches the whole mailbox); `after` = Date|ISO|ms.
export async function findMessages({ label = gmailLabel(), after, from, query, max = 50, excludeProcessed = false } = {}, { exec } = {}) {
  const q = [];
  if (label) q.push(`label:${searchLabel(label)}`);
  if (label && excludeProcessed) q.push(`-label:${searchLabel(processedLabel(label))}`);
  if (after !== undefined && after !== null) {
    const ms = after instanceof Date ? after.getTime() : typeof after === 'number' ? after : Date.parse(after);
    if (!Number.isFinite(ms)) throw Error(`findMessages: bad "after" value ${after}`);
    q.push(`after:${Math.floor(ms / 1000)}`); // Gmail accepts epoch seconds for exact cutoffs
  }
  if (from) q.push(`from:${from}`);
  if (query) q.push(`(${query})`);
  const out = [];
  let page_token;
  do {
    const data = await call(exec, GMAIL.FETCH_EMAILS, {
      query: q.join(' '), max_results: Math.min(500, max - out.length), include_payload: true, verbose: true,
      ...(page_token ? { page_token } : {}),
    });
    for (const m of data?.messages || []) {
      if (m.messageId || m.id) out.push(parseMessage(m));
      if (out.length >= max) break;
    }
    page_token = data?.nextPageToken || undefined;
  } while (page_token && out.length < max);
  return out;
}

export async function fetchMessage(messageId, { exec } = {}) {
  return parseMessage(await call(exec, GMAIL.FETCH_MESSAGE, { message_id: messageId, format: 'full' }));
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw Error(`Attachment download returned HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Composio returns attachments as a hosted file (s3url) or, in some versions, inline base64.
export async function getAttachment(message, attachment, { exec } = {}) {
  if (attachment.data) return b64(attachment.data);
  if (!attachment.attachmentId) throw Error(`Attachment ${attachment.filename} has no attachmentId`);
  const data = await call(exec, GMAIL.GET_ATTACHMENT, {
    message_id: message.id ?? message, attachment_id: attachment.attachmentId, file_name: attachment.filename || 'attachment',
  });
  const f = data?.file ?? data?.downloaded_file_content ?? data;
  const url = f?.s3url || f?.url || f?.download_url || data?.s3url || data?.url;
  if (url) return download(url);
  const inline = f?.data ?? f?.content ?? data?.data ?? data?.content;
  if (typeof inline === 'string' && inline) return b64(inline);
  throw Error(`Gmail returned no content for attachment ${attachment.filename}`);
}

const labelCache = new Map();
export async function ensureLabel(name, { exec } = {}) {
  if (labelCache.has(name)) return labelCache.get(name);
  const list = await call(exec, GMAIL.LIST_LABELS, {});
  let found = (list?.labels || []).find(l => l.name === name);
  if (!found) {
    const created = await call(exec, GMAIL.CREATE_LABEL, { label_name: name });
    found = created?.id ? created : (created?.label || null);
  }
  if (!found?.id) throw Error(`Could not find or create Gmail label "${name}"`);
  labelCache.set(name, found.id);
  return found.id;
}
export const _clearLabelCache = () => labelCache.clear();

// Record the message (and its ingested files) in the local ledger, then apply
// `${label}/processed` in Gmail. The ledger is authoritative; label failures are returned, not thrown.
export async function markProcessed(messageId, { exec, label = gmailLabel(), files = [] } = {}) {
  addFiles(messageId, files, { done: true });
  try {
    const id = await ensureLabel(processedLabel(label), { exec });
    await call(exec, GMAIL.ADD_LABEL, { message_id: messageId, add_label_ids: [id], remove_label_ids: [] });
    return { ledger: true, labeled: true };
  } catch (e) {
    return { ledger: true, labeled: false, error: e?.message || String(e) };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll for the newest message (whole mailbox unless `label` given) received after `after`
// and pull an MFA code out of its subject or body.
export async function waitForEmailCode(
  { from, after = new Date(), pattern = /\b(\d{6})\b/, timeoutMs = 120000, pollMs = 5000, query, label = null } = {},
  { exec } = {},
) {
  const afterMs = after instanceof Date ? after.getTime() : typeof after === 'number' ? after : Date.parse(after);
  if (!Number.isFinite(afterMs)) throw Error(`waitForEmailCode: bad "after" value ${after}`);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      // Gmail's after: is second-granular; re-filter on receivedAt below.
      const msgs = await findMessages({ label, after: afterMs - 1000, from, query, max: 10 }, { exec });
      msgs.sort((a, b) => Date.parse(b.receivedAt || 0) - Date.parse(a.receivedAt || 0));
      for (const m of msgs) {
        if (m.receivedAt && Date.parse(m.receivedAt) < afterMs) continue;
        for (const text of [m.subject, stripHtml(m.bodyHtml || ''), m.bodyText, m.snippet]) {
          const hit = text && String(text).match(pattern);
          if (hit) return hit[1] ?? hit[0];
        }
      }
    } catch (e) { lastError = e; }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(pollMs, left));
  }
  throw Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for an emailed code${from ? ` from ${from}` : ''} received after ${new Date(afterMs).toISOString()}${lastError ? ` (last Gmail error: ${lastError.message})` : ''}`);
}
