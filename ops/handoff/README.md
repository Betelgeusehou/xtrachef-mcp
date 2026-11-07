# Session handoff (Chrome to ops server)

DoorDash, Uber Eats, Grubhub, Homebase and Toast put bot checks on sign-in, so the
server can't log in headless. Chris's own Chrome is already signed in. The handoff
copies those signed-in sessions to the server, and the server reuses them in `session`
mode until they expire.

The portals keep their auth cookies `httpOnly`, so page JavaScript (including the Claude
in Chrome javascript tool) can't read them. A Chrome extension with the `cookies`
permission can. That's why the main path is the small extension in `extension/`.
`chrome-task.md` is the fallback for when the extension can't do the job.

## What's in `extension/`

| File | Job |
|---|---|
| `manifest.json` | MV3. Permissions: `cookies`, `alarms`, `storage`, `notifications`. Host access only to the vendor hosts (see "Cookie scope" below). The server's origin isn't pre-granted: Options asks for exactly that origin when you save. |
| `background.js` | Service worker (ES module). Daily alarm at 3:30 AM local, plus "Push now". Reads cookies per vendor domain, converts them, POSTs them. |
| `convert.js` | Pure functions: default vendor hosts, Chrome cookie to Playwright storageState, signed-in check, fingerprint, scheduling. Covered by node tests. |
| `options.html/js` | Paste the server URL and token. |
| `popup.html/js` | Last push per vendor, "Push now" button. |

## Install (once, on the Chrome profile that's signed in to the portals)

1. Set `OPS_HANDOFF_TOKEN` on the Railway service. It needs at least 32 characters:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. Copy the `ops/handoff/extension` folder to the Mac (or clone the repo).
3. Chrome: `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the `extension` folder.
4. Pin the extension and open **Options**:
   - **Server URL**: the MCP URL without `/mcp`, i.e. `https://<service>.up.railway.app/<XTRACHEF_MCP_SECRET>`
   - **Token**: the `OPS_HANDOFF_TOKEN` value
   - Click **Save and push now**. Chrome asks once for permission to reach that server origin; allow it. Each vendor should show `pushed`, or a message saying which portal to sign in to.
5. Leave Chrome running overnight with the Mac awake (System Settings > Battery > Options > *Prevent automatic sleeping when the display is off*). The alarm fires at 3:30 AM local time. If Chrome was closed at 3:30, it fires when Chrome next opens.

## What it sends

For each vendor, `POST <server>/ops/handoff/<vendorId>`, with header `Authorization: Bearer <OPS_HANDOFF_TOKEN>` and this body:

```json
{ "storageState": { "cookies": [{ "name": "...", "value": "...", "domain": ".doordash.com", "path": "/", "expires": 1767225600, "httpOnly": true, "secure": true, "sameSite": "Lax" }], "origins": [] }, "url": "https://merchant-portal.doordash.com/" }
```

- It sends only cookies for that vendor's hosts. The vendor list and hosts come from `GET <server>/ops/handoff/vendors`, which is built from each adapter's `loginUrl` plus its optional `handoffDomains`. If that call fails, the extension uses the defaults in `convert.js`.
- It skips a vendor that looks signed out, meaning it has no long-lived httpOnly cookie. That check is only a first filter. The server runs the real sign-in check (below) and answers 409 if the session isn't signed in; the popup then says which portal to sign in to, and a Chrome notification fires.
- It skips a session that hasn't changed, but still re-pushes at least every 3 days so the server's session age stays fresh.
- localStorage isn't sent (`origins: []`). An adapter that needs localStorage would need a content script added for its origin.
- Cookie values and the token are never logged by the extension or the server. The server's response is `{ok, vendor, verified, cookies, dropped, sync}`, and it never echoes cookies back.

## Cookie scope

| Vendor | Hosts pushed (`DEFAULT_VENDORS` and the adapter's `handoffDomains`) |
|---|---|
| doordash | `doordash.com` |
| ubereats | `merchants.ubereats.com`, `auth.uber.com` (not the rest of uber.com) |
| grubhub | `grubhub.com` |
| homebase | `joinhomebase.com` |
| toast-payroll | `payroll.toasttab.com`, `auth.toasttab.com` (not the rest of toasttab.com) |

For each host the extension reads that host's cookies (and its subdomains'), plus parent-domain cookies
the browser sends to it, such as a `.uber.com` cookie on `auth.uber.com`. That's why `manifest.json` also
has the bare `https://uber.com/*`, `https://ubereats.com/*` and `https://toasttab.com/*`: they grant
exactly that parent host, not its other subdomains. `riders.uber.com` or `www.toasttab.com` cookies are
never read.

The server filter matches. When an adapter lists `handoffDomains`, the allowed hosts are the `loginUrl`
host plus each listed entry, kept exact. A cookie passes if its domain is one of those hosts or a
subdomain of one (host-only cookies included), or if it's a domain cookie (leading dot) on a parent of
one, other than a bare public suffix. Listing a bare registrable domain such as `doordash.com` still
allows all of that domain. An adapter with no `handoffDomains` falls back to its `loginUrl`'s registrable
domain. Note: `ops/vendors/ubereats.mjs` and `ops/vendors/toast-payroll.mjs` still list the bare
`uber.com`/`toasttab.com`, so the server accepts the wider set until those adapters are narrowed too.

## On the server

`ops/http.mjs` runs these checks in order:
1. `OPS_HANDOFF_TOKEN` is unset or shorter than 32 characters: **503**.
2. Bearer token wrong (constant-time compare): **401**.
3. `OPS_ENABLED` isn't `true`: **503** `ops layer disabled (set OPS_ENABLED=true)`. Nothing is stored.
4. Vendor id not in the registry: **404**.
5. Body is over 2 MB: **413**.
6. The storageState shape is bad, or no cookies are left after domain filtering: **400**.

Cookies and origins for other hosts are dropped and counted in `dropped`. Then, inside the runner's
browser lock (`withBrowserLock`, so it never overlaps a collector run):

1. The current session is read (`loadSession`) and kept aside.
2. The pushed session is saved with source `handoff-pending`, and `sessionAlive(adapter)` opens it
   headless and runs the adapter's `isLoggedIn`.
3. **Signed in:** saved with source `handoff` (keeping any cookies the portal refreshed during the
   check). Response **200** `{ok:true, verified:true, ...}`. A `runVendorLocked(id)` then starts in the
   background; the response doesn't wait for it.
4. **Not signed in:** the previous session is put back as it was (or cleared if there wasn't one).
   Response **409** `{ok:false, error:'session not signed in'}`. A signed-out Chrome can't overwrite a
   working session.
5. **Check couldn't run** (no browser on the server, navigation error, or the adapter has no
   `isLoggedIn`): the pushed session is kept with source `handoff-unverified`. Response **202**
   `{ok:true, verified:false, ...}`, no background run. The extension re-pushes it next time instead of
   treating it as unchanged.

## Revoke

- **Stop one machine:** remove the extension in `chrome://extensions`. That also deletes its stored URL and token.
- **Kill every pusher:** change or unset `OPS_HANDOFF_TOKEN` on Railway. Unset returns 503 and a changed token returns 401. Then paste the new token into Options on the machines you keep.
- **Drop a stored session:** call `clearSession('<vendor>')` from `ops/core/vault.mjs`, or delete `/data/ops/sessions/<vendor>.enc`. Signing out of the portal in Chrome also ends the session server-side for most vendors.
- If a portal session might be compromised, sign out of all sessions inside that portal's security settings.
