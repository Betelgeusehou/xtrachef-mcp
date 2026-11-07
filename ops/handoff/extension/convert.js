// Pure helpers shared by the extension service worker and the node tests.
// No chrome.* APIs in here.

// Default vendor list, used when the server's /ops/handoff/vendors list can't be fetched.
// ids must match ops/vendors/<id>.mjs; domains are registrable domains whose cookies get pushed.
export const DEFAULT_VENDORS = [
  { id: 'doordash', name: 'DoorDash Merchant', loginUrl: 'https://merchant-portal.doordash.com/', domains: ['doordash.com'] },
  { id: 'ubereats', name: 'Uber Eats Manager', loginUrl: 'https://merchants.ubereats.com/', domains: ['ubereats.com', 'uber.com'] },
  { id: 'grubhub', name: 'Grubhub for Restaurants', loginUrl: 'https://restaurant.grubhub.com/', domains: ['grubhub.com'] },
  { id: 'homebase', name: 'Homebase', loginUrl: 'https://app.joinhomebase.com/', domains: ['joinhomebase.com'] },
  { id: 'toast', name: 'Toast / Toast Payroll', loginUrl: 'https://www.toasttab.com/restaurants/admin/home', domains: ['toasttab.com'] },
];

const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' };

// chrome.cookies.Cookie -> Playwright storageState cookie.
export function chromeToPlaywright(c) {
  let sameSite = SAME_SITE[c.sameSite] || 'Lax';
  // Chromium refuses SameSite=None without Secure; Playwright would fail to add it.
  if (sameSite === 'None' && !c.secure) sameSite = 'Lax';
  // Host-only cookies have no leading dot; domain cookies keep it (Chrome already reports it that way).
  let domain = String(c.domain || '');
  if (c.hostOnly) domain = domain.replace(/^\.+/, '');
  else if (!domain.startsWith('.')) domain = '.' + domain;
  const expires = c.session || typeof c.expirationDate !== 'number' ? -1 : Math.floor(c.expirationDate);
  return { name: c.name, value: c.value, domain, path: c.path || '/', expires, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite };
}

// Merge cookie lists (one per domain query), drop duplicates and partitioned cookies, convert.
export function toStorageState(cookieLists) {
  const seen = new Set();
  const cookies = [];
  for (const list of cookieLists) for (const c of list || []) {
    if (c.partitionKey) continue; // CHIPS cookies can't be represented in storageState
    const k = `${c.domain}\u0000${c.path}\u0000${c.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    cookies.push(chromeToPlaywright(c));
  }
  return { cookies, origins: [] };
}

// Heuristic: a signed-in portal carries at least one httpOnly cookie that outlives a day.
// Signed-out browsers usually only hold analytics cookies plus short-lived bot-check cookies.
// Used to avoid overwriting a good server-side session with a signed-out one.
export function likelySignedIn(state, now = Date.now()) {
  const day = now / 1000 + 86400;
  return state.cookies.some(c => c.httpOnly && (c.expires === -1 || c.expires > day) && !/^(__cf_bm|cf_clearance|_cfuvid|__cfruid|AWSALB.*|incap_ses.*|visid_incap.*|datadome)$/i.test(c.name));
}

// Stable fingerprint of the auth-relevant part of a session, to skip pushing unchanged state.
export async function fingerprint(state) {
  const text = state.cookies.filter(c => c.httpOnly).map(c => `${c.domain}|${c.path}|${c.name}=${c.value}`).sort().join('\n');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ms until the next local hh:mm (always in the future).
export function msUntil(hour, minute, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// Normalize the server base URL the user pastes ("https://host/<secret>" with or without trailing slash or /mcp).
export function normalizeBase(url) {
  const u = new URL(String(url).trim());
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) throw Error('Server URL must be https');
  return (u.origin + u.pathname).replace(/\/+$/, '').replace(/\/mcp$/, '');
}
