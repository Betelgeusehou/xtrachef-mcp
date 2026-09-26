# Sandcastles cloud authorization

Prepared only. No client registration or authorization has been performed by these scripts during development.

The existing Railway service runs the deterministic collector when `SANDCASTLES_ENABLED=true`. It retains the verified three-channel social seed and reads only `get_personal_analytics`; this is a free read, not video analysis. No additional runtime or subscription is needed for this proposed route.

The collector makes one upstream read per hour during 5 AM–11 PM Chicago time, returning all three channels. `upstreamIntervalHours:1` describes those reads; `sourceRefreshHours:12` separately describes the published Pro source refresh interval. A successful read sets `checkedAt`; seven-day period dates remain source dates. Unchanged figures are valid cached provider observations. Future or regressed periods are rejected.

## Explicit bootstrap from the existing Railway server console

Use the existing `/data` mounted volume. Never download desktop OAuth credentials, put tokens in Drive, echo environment variables, or pass tokens as command arguments.

1. Deploy these reviewed files with `SANDCASTLES_ENABLED` unset. Confirm `/data/dashboard/social/snapshot.json` has all three existing handles.
2. Run `SANDCASTLES_BOOTSTRAP_ALLOWED=true node dashboard/sandcastles-bootstrap.mjs register` once. Repeating this command reuses an existing registered client.
3. Run `SANDCASTLES_BOOTSTRAP_ALLOWED=true node dashboard/sandcastles-bootstrap.mjs authorize`. Give the returned verification URL and short-lived user code to the owner. They authorize the dedicated **Store Pulse Cloud Dashboard** client on Sandcastles. The script never prints the device token.
4. After owner consent, run `SANDCASTLES_BOOTSTRAP_ALLOWED=true node dashboard/sandcastles-bootstrap.mjs poll`. If pending, retry only after the indicated interval (default five seconds). On success, refresh and access tokens are saved privately; no tokens are printed.
5. Enable `SANDCASTLES_ENABLED=true` on the existing service and redeploy. Verify the social status and all three source dates at the next eligible refresh.

Persistent OAuth file: `/data/dashboard/auth/sandcastles.json`, private file mode 0600 in directory mode 0700. It contains dedicated client metadata and rotating refresh/access tokens. Refresh-token changes are persisted atomically before the access token is used. Normal API routes do not expose this file. Restrict service/volume administration appropriately.

## Prerequisites and fallback

Public metadata advertises device authorization, refresh tokens, dynamic client registration, `offline_access`, and public-client token authentication. Acceptance of a custom device-grant registration is not yet verified. If registration or device authorization is rejected, stop: use a separately registered authorization-code/PKCE client and HTTPS callback instead. Do not retry by extracting another client's tokens or assume the generic OIDC client-credentials grant authorizes personal analytics.

The collector requires all three known channel IDs and complete seven-day figures. Wrong-workspace or partial data leaves the last-good snapshot intact. Missing follower history is `gained:null`, not zero. The site must render that as unavailable. Revoked or expired authorization leaves a generic failure status and requires the dedicated client to be reauthorized.

Public metadata read during preparation:
- https://mcp.sandcastles.ai/.well-known/oauth-protected-resource
- https://mcp.sandcastles.ai/.well-known/oauth-authorization-server
- https://signin.sandcastles.ai/.well-known/openid-configuration

No paid analysis tools are used.

## Prepared PKCE fallback (not registered or deployed)

The authorization-code fallback adds `/dashboard/oauth/sandcastles/callback` to the existing service. It is disabled unless `SANDCASTLES_OAUTH_CALLBACK_ENABLED=true`. Set `SANDCASTLES_REDIRECT_URI` to that exact HTTPS path on the existing service hostname, without query or fragment. Configure proxy/access logs to omit callback query strings (they contain a short-lived authorization code).

After review, deploy the code with collection still disabled. Verify callback routing before registration. Explicit operator steps (none performed during implementation):

1. `SANDCASTLES_BOOTSTRAP_ALLOWED=true node dashboard/sandcastles-bootstrap.mjs prepare-pkce` prints registration metadata only.
2. `SANDCASTLES_BOOTSTRAP_ALLOWED=true node dashboard/sandcastles-bootstrap.mjs register-pkce` registers a dedicated public authorization-code/refresh client. Existing client IDs are reused, never overwritten; an incompatible pre-existing device client must be resolved explicitly rather than deleted silently.
3. `SANDCASTLES_BOOTSTRAP_ALLOWED=true node dashboard/sandcastles-bootstrap.mjs authorize-pkce` creates a ten-minute link for the owner. The verifier and state stay in the private volume; only the authorization link is returned. Owner approves **Store Pulse Cloud Dashboard** using their Sandcastles account.
4. The callback consumes matching state once before token exchange, validates exact redirect and client identity, and exchanges with S256 verifier. Failures retain previous tokens; consumed/expired links need a new authorization attempt. Success stores the dedicated tokens privately and displays a generic completion page.
5. Verify authorization without printing tokens; enable the existing scheduled collector and check the next eligible read. Do not infer success from OAuth alone.

Pending state lives beside the private auth file as `sandcastles.json.pkce`, with the same private file mode. Authorization bootstrap and collector refresh must not run concurrently; keep `SANDCASTLES_ENABLED` disabled during consent. No refresh/access token or provider error body is returned to the browser or diagnostics. Provider acceptance of this registration remains untested.

Callback origin hardening: redirect validation is now bound to the existing service's platform-provided `RAILWAY_PUBLIC_DOMAIN` and the exact callback path. It rejects other HTTPS hosts, other Railway service hosts, ports, and missing domain configuration. Do not derive the allowed origin from incoming Host/forwarded headers. Verify the existing service publishes `RAILWAY_PUBLIC_DOMAIN` before preparation; no new domain or service is required.

Application logging review: `src/main.js` delegates to `handleDashboard` before its MCP request/error handlers; `dashboard/http.mjs` delegates this callback before bearer-only routes. The callback catches exchange errors with fixed text, has no console calls, and sets no-store/no-referrer. The integration test invokes the actual dashboard handler with a sentinel authorization code and verifies neither response nor console output contains it. Railway edge/proxy access-log query handling is outside repository evidence and still needs deployment-side verification.
