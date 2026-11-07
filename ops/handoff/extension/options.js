import { normalizeBase } from './convert.js';
const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };

chrome.storage.local.get(['serverBase', 'token']).then(({ serverBase, token }) => {
  if (serverBase) $('base').value = serverBase;
  $('token').placeholder = token ? 'saved (leave blank to keep)' : 'paste OPS_HANDOFF_TOKEN';
});

async function save() {
  const base = normalizeBase($('base').value);
  const token = $('token').value.trim();
  const stored = await chrome.storage.local.get('token');
  if (!token && !stored.token) throw Error('Paste the handoff token');
  if (token && token.length < 32) throw Error('Token must be at least 32 characters');
  // The service worker can only reach origins it has host permission for. Nothing is pre-granted for the
  // server: this asks for exactly its origin (manifest optional_host_permissions) on Save.
  const origin = new URL(base).origin + '/*';
  const granted = await chrome.permissions.contains({ origins: [origin] }) || await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw Error('Permission to reach the server was denied');
  await chrome.storage.local.set({ serverBase: base, ...(token ? { token } : {}) });
  $('token').value = '';
  $('token').placeholder = 'saved (leave blank to keep)';
  await chrome.runtime.sendMessage({ type: 'reschedule' });
}

$('save').onclick = () => save().then(() => msg('Saved. Daily push runs at 3:30 AM local.'), e => msg(e.message));
$('test').onclick = () => save()
  .then(() => { msg('Pushing…'); return chrome.runtime.sendMessage({ type: 'push-now' }); })
  .then(r => msg(r?.error ? r.error : Object.entries(r.results).map(([id, x]) => `${x.name || id}: ${x.ok ? x.status : x.message}`).join('\n')), e => msg(e.message));
