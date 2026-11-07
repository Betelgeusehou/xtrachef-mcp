# Scheduled Claude task: vendor portal session check (fallback)

The **Ops Session Handoff extension** (`ops/handoff/extension`) does the actual cookie push at 3:30 AM.
Claude in Chrome can't read httpOnly cookies, so this task never copies cookies itself. It does two jobs:

1. Make sure each portal is still signed in, so the extension's next push carries a live session.
2. Kick the extension's push and confirm the server got fresh sessions. If not, tell Chris exactly which portal needs him.

Schedule it daily at **3:40 AM America/Chicago**, ten minutes after the extension's own alarm, in Chris's real Chrome with the Claude in Chrome extension connected.

---

## Prompt

You're running the nightly vendor-session check for Betelgeuse in Chris's own Chrome. Work only in new tabs you open, and close them when you're done.

**Hard rules**
- Never type, paste, reveal or autofill a password, one-time code or security answer. Never click "Forgot password". Never solve a CAPTCHA or bot check. If a page asks for any of these, stop work on that vendor and record it as needing Chris.
- Chrome's own saved sign-in can restore a session by itself when the page loads. That's fine. Don't press anything that submits credentials.
- Don't read, copy or print cookies, tokens or page storage. Don't change any setting in any portal.
- Don't open any URL other than the ones below and the server status URL.

**Vendors.** For each one, open the URL in a new tab and wait for the page to finish loading (up to 30 seconds):

| Vendor id | Portal | Signed in looks like | Signed out looks like |
|---|---|---|---|
| doordash | https://merchant-portal.doordash.com/ | Store dashboard, store name visible | "Log in" / identity.doordash.com |
| ubereats | https://merchants.ubereats.com/manager/ | Uber Eats Manager home, Betelgeuse store | auth.uber.com sign-in |
| grubhub | https://restaurant.grubhub.com/ | Grubhub for Restaurants dashboard | Sign-in form |
| homebase | https://app.joinhomebase.com/ | Schedule or timesheets page | Sign-in form |
| toast | https://www.toasttab.com/restaurants/admin/home | Toast Web home, a Betelgeuse location | auth.toasttab.com sign-in |

For each vendor:
1. Decide whether you're **signed in** from the table: URL, page title, visible store name. Use `get_page_text` or `find`. Don't interact with sign-in forms.
2. If you're signed in, click nothing more. Just viewing the page refreshes the portal's own cookies. Record `signed_in`.
3. If you're signed out, or the page shows a bot check or a code prompt, record `needs_chris` and the reason, e.g. "Toast is asking for an emailed code". Move on to the next vendor.
4. Close the tab.

**Push.** Click the **Ops Session Handoff** extension icon and press **Push now**. Wait up to 60 seconds and read the popup's table. Record each vendor's status: `pushed`, `unchanged`, or the message shown.

**Verify.** Open `{{SERVER_BASE}}/ops/status` in a new tab. This is the server URL with the secret path, the same value as the extension's Options. Read the JSON. For each vendor, note `sessionSavedAt` and `problems`, then close the tab. Never paste this URL into the notification.

**Notify Chris only if something needs him.** Something needs him when a vendor is `needs_chris`, when the popup shows an error, or when a vendor's `sessionSavedAt` is older than 3 days. Send one short notification:

> Ops sessions: sign in to Toast (asking for an emailed code) and Grubhub (signed out) in Chrome, then press Push now on the Ops Session Handoff extension. Others are fresh.

If everything is fresh, finish quietly with a one-line log like "5/5 sessions fresh". Don't notify.

**If the extension is missing or unconfigured,** the popup says "Not configured" or the icon is absent. Notify Chris: "The Ops Session Handoff extension isn't set up in this Chrome. See ops/handoff/README.md." Don't try to work around it.
