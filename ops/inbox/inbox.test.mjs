// node --test 'ops/inbox/*.test.mjs'   (no network: fake Composio exec, mocked fetch)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-inbox-'));
process.env.OPS_DATA_DIR = tmp;
delete process.env.OPS_DRIVE_FOLDER_ID;
delete process.env.OPS_GMAIL_ACCOUNT;

const gmail = await import('./gmail.mjs');
const { sweepInbox, sweepDrive } = await import('./index.mjs');
const { unzip } = await import('./zip.mjs');
const store = await import('../core/store.mjs');

const fixture = () => JSON.parse(fs.readFileSync(path.join(FIX, 'fetch-emails.json'), 'utf8'));
const CSV = fs.readFileSync(path.join(FIX, 'doordash_orders.csv'));
const ZIP = fs.readFileSync(path.join(FIX, 'reports.zip'));

// Fake composioExecute: handlers keyed by slug; logs every call.
function fakeExec(handlers) {
  const calls = [];
  const exec = async tools => tools.map(t => {
    calls.push(t);
    const h = handlers[t.tool_slug];
    if (!h) throw Error(`unexpected tool ${t.tool_slug}`);
    return typeof h === 'function' ? h(t.arguments, t) : h;
  });
  return { exec, calls };
}

const realFetch = globalThis.fetch;
let fetched = [];
function mockFetch(map) {
  globalThis.fetch = async url => {
    fetched.push(String(url));
    const body = map[String(url)];
    if (!body) return new Response('nope', { status: 404 });
    return new Response(body, { status: 200 });
  };
}

beforeEach(() => {
  for (const f of ['inbox-ledger.json', 'inbox-state.json']) fs.rmSync(path.join(tmp, f), { force: true });
  gmail._clearLabelCache();
  fetched = [];
});
afterEach(() => { globalThis.fetch = realFetch; });

const ddAdapter = (seen = []) => ({
  id: 'doordash', modes: ['session', 'inbox'],
  matchFile: m => /doordash/i.test(m.from) && /\.csv$/i.test(m.filename),
  parseFile: (buf, meta) => {
    seen.push({ text: buf.toString('utf8'), meta });
    const [, ...rows] = buf.toString('utf8').trim().split('\n');
    return { delivery_orders: rows.map(r => { const [order_id, s, payout] = r.split(','); return { vendor: 'doordash', order_id, store: store.KINDS && 'Montrose', business_date: '2026-11-02', payout: Number(payout), source: s }; }) };
  },
});

test('findMessages parses the recorded Composio shape', async () => {
  const { exec, calls } = fakeExec({ GMAIL_FETCH_EMAILS: fixture() });
  const msgs = await gmail.findMessages({ label: 'ops-reports', after: '2026-11-01T00:00:00Z', from: 'doordash.com', max: 50 }, { exec });
  assert.equal(calls[0].arguments.query, `label:"ops-reports" after:${Date.parse('2026-11-01T00:00:00Z') / 1000} from:doordash.com`);
  assert.equal(calls[0].arguments.verbose, true);
  assert.equal(calls[0].arguments.include_payload, true);
  assert.equal(msgs.length, 2);
  const [a, b] = msgs;
  assert.equal(a.id, '18f0a1b2c3d4e5f6');
  assert.equal(a.from, 'DoorDash <no-reply@doordash.com>');
  assert.equal(a.subject, 'Your weekly DoorDash report');
  assert.equal(a.receivedAt, '2026-11-03T14:05:00.000Z');
  assert.equal(a.bodyText, 'See attached.');
  assert.equal(a.bodyHtml, '<p>See attached.</p>');
  assert.deepEqual(a.attachments, [{ attachmentId: 'ANGjdJ8sAAA', filename: 'doordash_orders.csv', mimeType: 'text/csv', size: 52 }]);
  assert.equal(b.receivedAt, new Date(1762300000000).toISOString());
  assert.match(b.bodyHtml, /<table>/);
  assert.equal(b.attachments.length, 0);
});

test('findMessages follows nextPageToken up to max', async () => {
  const f = fixture();
  const { exec, calls } = fakeExec({
    GMAIL_FETCH_EMAILS: args => args.page_token ? { messages: [f.messages[1]], nextPageToken: '' } : { messages: [f.messages[0]], nextPageToken: 'p2' },
  });
  const msgs = await gmail.findMessages({ label: null, max: 5 }, { exec });
  assert.equal(msgs.length, 2);
  assert.equal(calls[1].arguments.page_token, 'p2');
});

test('getAttachment: s3 URL path downloads via fetch', async () => {
  mockFetch({ 'https://s3.example/att.csv': CSV });
  const { exec, calls } = fakeExec({ GMAIL_GET_ATTACHMENT: { file: { name: 'doordash_orders.csv', mimetype: 'text/csv', s3url: 'https://s3.example/att.csv' } } });
  const buf = await gmail.getAttachment({ id: 'm1' }, { attachmentId: 'A1', filename: 'doordash_orders.csv' }, { exec });
  assert.deepEqual(buf, CSV);
  assert.deepEqual(calls[0].arguments, { message_id: 'm1', attachment_id: 'A1', file_name: 'doordash_orders.csv' });
});

test('getAttachment: inline base64(url) data path, no fetch', async () => {
  mockFetch({});
  const { exec } = fakeExec({ GMAIL_GET_ATTACHMENT: { data: CSV.toString('base64url') } });
  assert.deepEqual(await gmail.getAttachment({ id: 'm1' }, { attachmentId: 'A1', filename: 'x.csv' }, { exec }), CSV);
  // inline part data on the attachment itself skips Composio entirely
  assert.deepEqual(await gmail.getAttachment({ id: 'm1' }, { filename: 'x.csv', data: CSV.toString('base64') }, { exec: () => { throw Error('should not call'); } }), CSV);
  assert.equal(fetched.length, 0);
});

test('waitForEmailCode finds a code in the HTML body after `after`', async () => {
  const after = new Date('2026-11-07T10:00:00Z');
  let polls = 0;
  const { exec } = fakeExec({
    GMAIL_FETCH_EMAILS: () => {
      polls++;
      if (polls < 2) return { messages: [] };
      return { messages: [
        { messageId: 'old', sender: 'no-reply@toast.com', subject: 'Code 111111', messageTimestamp: '2026-11-07T09:59:00Z' },
        { messageId: 'new', sender: 'no-reply@toast.com', subject: 'Your verification code', messageTimestamp: '2026-11-07T10:00:30Z',
          payload: { mimeType: 'text/html', body: { data: Buffer.from('<div style="x">Code:<b>482913</b></div>').toString('base64url') } } },
      ] };
    },
  });
  const code = await gmail.waitForEmailCode({ from: 'toast.com', after, timeoutMs: 2000, pollMs: 10 }, { exec });
  assert.equal(code, '482913');
  assert.equal(polls, 2);
});

test('waitForEmailCode times out with a clear message', async () => {
  const { exec } = fakeExec({ GMAIL_FETCH_EMAILS: { messages: [] } });
  await assert.rejects(
    gmail.waitForEmailCode({ from: 'doordash.com', timeoutMs: 60, pollMs: 10 }, { exec }),
    /Timed out after 0s waiting for an emailed code from doordash\.com/,
  );
});

test('unzip reads deflate and stored entries', () => {
  const entries = unzip(ZIP);
  assert.deepEqual(entries.map(e => e.name), ['big_orders.csv', 'sub/stored.csv']);
  assert.match(entries[0].data.toString(), /^order_id,store,payout\nZ1,/);
  assert.equal(entries[0].data.toString().trim().split('\n').length, 201);
  assert.equal(entries[1].data.toString(), 'a,b\n1,2\n');
});

function inboxExec({ messages, files }) {
  return fakeExec({
    GMAIL_FETCH_EMAILS: { messages, nextPageToken: '' },
    GMAIL_GET_ATTACHMENT: a => ({ file: { name: a.file_name, mimetype: 'text/csv', s3url: `https://s3.example/${a.attachment_id}` } }),
    GMAIL_LIST_LABELS: { labels: [{ id: 'Label_42', name: 'ops-reports' }] },
    GMAIL_CREATE_LABEL: a => ({ id: 'Label_99', name: a.label_name }),
    GMAIL_ADD_LABEL_TO_EMAIL: a => ({ id: a.message_id, labelIds: a.add_label_ids }),
    ...files,
  });
}

test('sweepInbox routes to the first matching inbox adapter, reports unclaimed, marks processed', async () => {
  mockFetch({ 'https://s3.example/ANGjdJ8sAAA': CSV });
  const seen = [];
  const sessionOnly = { id: 'session-only', modes: ['session'], matchFile: () => true, parseFile: () => { throw Error('must not be used'); } };
  const second = { id: 'second', modes: ['inbox'], matchFile: m => /doordash/i.test(m.from), parseFile: () => { throw Error('must not be used'); } };
  const { exec, calls } = inboxExec({ messages: fixture().messages });
  const items = await sweepInbox({ adapters: [sessionOnly, ddAdapter(seen), second], exec });

  const dd = items.find(i => i.vendor === 'doordash');
  assert.equal(dd.ok, true);
  assert.equal(dd.mode, 'inbox');
  assert.equal(dd.file, 'doordash_orders.csv');
  assert.equal(dd.records, 1);
  assert.equal(dd.result.delivery_orders[0].order_id, 'A1');
  assert.equal(seen[0].meta.messageId, '18f0a1b2c3d4e5f6');
  assert.equal(seen[0].meta.mimeType, 'text/csv');
  assert.equal(seen[0].meta.receivedAt, '2026-11-03T14:05:00.000Z');

  // Homebase message has no attachment -> body.html candidate, nobody claims it
  const un = items.find(i => i.messageId === '18f0a1b2c3d4e5f7');
  assert.deepEqual({ vendor: un.vendor, ok: un.ok, error: un.error, file: un.file }, { vendor: null, ok: false, error: 'no adapter matched', file: 'body.html' });

  // processed label created (missing) and applied only to the fully-claimed message
  assert.ok(calls.some(c => c.tool_slug === 'GMAIL_CREATE_LABEL' && c.arguments.label_name === 'ops-reports/processed'));
  const adds = calls.filter(c => c.tool_slug === 'GMAIL_ADD_LABEL_TO_EMAIL');
  assert.deepEqual(adds.map(c => [c.arguments.message_id, c.arguments.add_label_ids]), [['18f0a1b2c3d4e5f6', ['Label_99']]]);

  // default lookback 14 days, cursor persisted
  const q = calls.find(c => c.tool_slug === 'GMAIL_FETCH_EMAILS').arguments.query;
  const afterSec = Number(q.match(/after:(\d+)/)[1]);
  assert.ok(Math.abs(afterSec - (Date.now() - 14 * 86400000) / 1000) < 60);
  const state = JSON.parse(fs.readFileSync(path.join(tmp, 'inbox-state.json'), 'utf8'));
  assert.ok(state.cursor);
});

test('body-as-file fallback: an adapter can claim body.html', async () => {
  const seen = [];
  const hb = { id: 'homebase', modes: ['inbox'], matchFile: m => /homebase/i.test(m.from) && m.filename === 'body.html',
    parseFile: buf => { seen.push(buf.toString()); return { labor_shifts: [] }; } };
  const { exec } = inboxExec({ messages: [fixture().messages[1]] });
  const items = await sweepInbox({ adapters: [hb], exec });
  assert.equal(items.length, 1);
  assert.equal(items[0].vendor, 'homebase');
  assert.equal(items[0].ok, true);
  assert.match(seen[0], /<table><tr><td>Labor<\/td>/);
});

test('ledger dedupes across two sweeps even when the Gmail label fails', async () => {
  mockFetch({ 'https://s3.example/ANGjdJ8sAAA': CSV });
  const seen = [];
  const { exec } = inboxExec({ messages: [fixture().messages[0]], files: { GMAIL_ADD_LABEL_TO_EMAIL: () => { throw Error('label API down'); } } });
  const first = await sweepInbox({ adapters: [ddAdapter(seen)], exec, since: 0 });
  assert.equal(first.length, 1);
  assert.equal(first[0].ok, true);
  assert.match(first[0].labelError, /label API down/);
  const second = await sweepInbox({ adapters: [ddAdapter(seen)], exec, since: 0 });
  assert.deepEqual(second, []);
  assert.equal(seen.length, 1);
  const ledger = JSON.parse(fs.readFileSync(path.join(tmp, 'inbox-ledger.json'), 'utf8'));
  assert.ok(ledger.messages['18f0a1b2c3d4e5f6']);
  assert.equal(Object.keys(ledger.files).length, 1);
});

test('unclaimed files stay retryable; claimed sibling in the same message is not re-parsed', async () => {
  mockFetch({ 'https://s3.example/A': CSV, 'https://s3.example/B': Buffer.from('junk') });
  const msg = { ...fixture().messages[0], payload: undefined, attachmentList: [
    { attachmentId: 'A', filename: 'doordash_orders.csv', mimeType: 'text/csv' },
    { attachmentId: 'B', filename: 'mystery.pdf', mimeType: 'application/pdf' },
  ] };
  const seen = [];
  const { exec } = inboxExec({ messages: [msg] });
  const one = await sweepInbox({ adapters: [ddAdapter(seen)], exec, since: 0 });
  assert.deepEqual(one.map(i => [i.file, i.vendor, i.ok]), [['doordash_orders.csv', 'doordash', true], ['mystery.pdf', null, false]]);
  const two = await sweepInbox({ adapters: [ddAdapter(seen)], exec, since: 0 });
  assert.deepEqual(two.map(i => [i.file, i.error]), [['mystery.pdf', 'no adapter matched']]);
  assert.equal(seen.length, 1);
});

test('zip attachments are expanded and each entry routed', async () => {
  mockFetch({ 'https://s3.example/Z': ZIP });
  const msg = { ...fixture().messages[0], payload: undefined, attachmentList: [{ attachmentId: 'Z', filename: 'weekly.zip', mimeType: 'application/zip' }] };
  const seen = [];
  const { exec } = inboxExec({ messages: [msg] });
  const items = await sweepInbox({ adapters: [ddAdapter(seen)], exec, since: 0 });
  assert.deepEqual(items.map(i => [i.file, i.vendor, i.records]), [['weekly.zip/big_orders.csv', 'doordash', 200], ['weekly.zip/sub/stored.csv', 'doordash', 1]]);
  assert.equal(seen[0].meta.filename, 'big_orders.csv');
  assert.equal(seen[0].meta.archive, 'weekly.zip');
});

test('persist: true upserts into the store and records runs per vendor', async () => {
  mockFetch({ 'https://s3.example/ANGjdJ8sAAA': CSV });
  const { exec } = inboxExec({ messages: fixture().messages });
  const items = await sweepInbox({ adapters: [ddAdapter()], exec, since: 0, persist: true });
  assert.equal(items.find(i => i.vendor === 'doordash').records, 1);
  const rows = store.query('delivery_orders', { vendor: 'doordash' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_mode, 'inbox');
  const run = store.lastRuns().find(r => r.vendor === 'doordash');
  assert.equal(run.mode, 'inbox');
  assert.equal(run.ok, 1);
});

test('sweepDrive routes folder files (with md5 versioning) and dedupes', async () => {
  mockFetch({ 'https://s3.example/d1': CSV, 'https://s3.example/d2': ZIP });
  const files = [
    { id: 'd1', name: 'doordash_orders.csv', mimeType: 'text/csv', md5Checksum: 'aaa', createdTime: '2026-11-06T10:00:00Z' },
    { id: 'd2', name: 'export.zip', mimeType: 'application/zip', md5Checksum: 'bbb', createdTime: '2026-11-06T11:00:00Z' },
    { id: 'f', name: 'sub', mimeType: 'application/vnd.google-apps.folder' },
  ];
  const drv = { id: 'dd-drive', modes: ['drive'], matchFile: m => m.from === 'drive' && /\.csv$/.test(m.filename), parseFile: buf => ({ delivery_orders: [{ order_id: 'x' + buf.length }] }) };
  const { exec, calls } = fakeExec({
    GOOGLEDRIVE_FIND_FILE: { files },
    GOOGLEDRIVE_DOWNLOAD_FILE: a => ({ downloaded_file_content: { name: a.fileId, mimetype: 'x', s3url: `https://s3.example/${a.fileId}` } }),
  });
  const items = await sweepDrive({ folderId: 'FOLDER', adapters: [drv], exec });
  assert.deepEqual(items.map(i => [i.file, i.vendor, i.mode, i.ok]), [
    ['doordash_orders.csv', 'dd-drive', 'drive', true],
    ['export.zip/big_orders.csv', 'dd-drive', 'drive', true],
    ['export.zip/sub/stored.csv', 'dd-drive', 'drive', true],
  ]);
  assert.equal(calls[0].arguments.folder_id, 'FOLDER');
  assert.equal(calls.filter(c => c.tool_slug === 'GOOGLEDRIVE_DOWNLOAD_FILE').length, 2);
  const again = await sweepDrive({ folderId: 'FOLDER', adapters: [drv], exec });
  assert.deepEqual(again, []);
  assert.equal(calls.filter(c => c.tool_slug === 'GOOGLEDRIVE_DOWNLOAD_FILE').length, 2, 'unchanged files are not re-downloaded');
});

test('sweepInbox also sweeps Drive when OPS_DRIVE_FOLDER_ID is set', async () => {
  mockFetch({ 'https://s3.example/d1': CSV });
  process.env.OPS_DRIVE_FOLDER_ID = 'FOLDER2';
  try {
    const drv = { id: 'any', modes: ['inbox'], matchFile: m => m.from === 'drive', parseFile: () => ({}) };
    const { exec } = fakeExec({
      GMAIL_FETCH_EMAILS: { messages: [] },
      GOOGLEDRIVE_FIND_FILE: { files: [{ id: 'd1', name: 'a.csv', mimeType: 'text/csv', md5Checksum: 'z' }] },
      GOOGLEDRIVE_DOWNLOAD_FILE: { downloaded_file_content: { s3url: 'https://s3.example/d1' } },
    });
    const items = await sweepInbox({ adapters: [drv], exec });
    assert.deepEqual(items.map(i => [i.mode, i.vendor, i.ok]), [['drive', 'any', true]]);
  } finally { delete process.env.OPS_DRIVE_FOLDER_ID; }
});
