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
