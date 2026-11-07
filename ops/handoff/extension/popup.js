const $ = id => document.getElementById(id);
const ago = iso => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

async function render() {
  const { results = {}, lastRun, serverBase } = await chrome.storage.local.get(['results', 'lastRun', 'serverBase']);
  $('last').firstElementChild.textContent = !serverBase ? 'Not configured — open Options.'
    : lastRun ? `Last run ${ago(lastRun.at)} (${lastRun.trigger}${lastRun.vendorSource === 'default' ? ', default vendor list' : ''})` : 'No push yet.';
  const rows = $('rows');
  rows.replaceChildren();
  for (const [id, r] of Object.entries(results).sort()) {
    const tr = document.createElement('tr');
    const name = document.createElement('td'); name.textContent = r.name || id;
    const st = document.createElement('td'); st.className = r.ok ? 'ok' : 'bad';
    st.textContent = r.ok ? `${r.status} · pushed ${ago(r.pushedAt)}` : (r.message || r.status);
    tr.append(name, st); rows.append(tr);
  }
}
$('push').onclick = async () => {
  $('push').disabled = true; $('push').textContent = 'Pushing…';
  try { await chrome.runtime.sendMessage({ type: 'push-now' }); } finally { $('push').disabled = false; $('push').textContent = 'Push now'; }
  render();
};
$('opts').onclick = () => chrome.runtime.openOptionsPage();
render();
