# BASE API — implementation notes

This system talks to BASE through a single abstraction (`lib/base/`), so that
if anything below turns out to be wrong, only `lib/base/client.real.ts` /
`lib/base/oauth.ts` need to change — nothing else in the app touches BASE's
wire format directly.

## OAuth2 (`lib/base/oauth.ts`) — implemented

- Authorize: `GET https://api.thebase.in/1/oauth/authorize` with
  `response_type=code&client_id=...&redirect_uri=...&scope=...&state=...`
- Token exchange: `POST https://api.thebase.in/1/oauth/token` with
  `grant_type=authorization_code&client_id=...&client_secret=...&redirect_uri=...&code=...`
- Refresh: same endpoint, `grant_type=refresh_token&client_id=...&client_secret=...&refresh_token=...`
- Scope used: `read_items`
- The token pair is persisted in Amplify Data (`BaseOAuthToken`, Admins-only,
  no public rule) instead of a static env var, because a refresh can rotate
  the refresh_token; `saveToken()` in `oauth.ts` handles both "BASE returned
  a new refresh_token" and "BASE omitted it, meaning unchanged."
- Admin-facing flow: `/admin/settings` → "BASEと接続する" → BASE's own
  consent screen → `/api/base/oauth/callback` (register this exact path —
  see README.md for the full URL) → token stored.

**If token exchange/refresh fails**, the error message from BASE's response
body is surfaced as-is on `/admin/settings` and in server logs — check that
first; it's usually a client_id/secret or redirect_uri mismatch.

## Item search / detail (`lib/base/client.real.ts`) — best-effort, self-checking

This environment could never reach `api.thebase.in` to see a live response
(network egress to all `thebase.in` hosts is blocked here), so the exact
field names in `mapItem()` are informed guesses, not verified ones:

- `GET /1/items` (paginated with `offset`/`limit`) is treated as a shop
  inventory list, not a full-text search API — `search()` pages through the
  catalog (up to 1000 items, 60s in-memory cache) and filters by
  title/description client-side, matching how the mock client behaves.
  If BASE's `/1/items` *does* support a server-side keyword param, that's a
  pure optimization to add later, not a correctness fix.
- `GET /1/items/detail?item_id=...` for a single item.
- `mapItem()` checks several plausible field-name variants per value
  (e.g. `item_id`/`itemId`/`id`) and **logs a console warning** —
  `[BASE mapItem] unexpected item shape` — whenever a required field (id,
  price, or images) comes back empty. **If `/admin/search` shows blank
  prices or missing images once BASE_USE_MOCK=false is live, check the
  server logs for that warning first** — it prints the raw response's key
  names, which is normally enough to fix `mapItem()` in one pass.

## Where each item plugs in

| Concern | File |
|---|---|
| OAuth endpoints, token persistence/refresh | `lib/base/oauth.ts` |
| OAuth start/callback routes | `app/api/base/oauth/start/route.ts`, `.../callback/route.ts` |
| Search/list + field mapping | `lib/base/client.real.ts` |
| Public-page BASE data (no token needed there) | `lib/features/baseSync.ts`, `app/features/[slug]/page.tsx` |
