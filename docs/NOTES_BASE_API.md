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

## Item search / detail (`lib/base/client.real.ts`)

This environment could never reach `api.thebase.in` directly, but a real
`/1/items` response has since been captured via server logs during Phase 1
testing, so the following is **confirmed, not guessed**:

- Images: flat, numbered fields — `img1_origin`, `img2_origin`, … up to
  `img20_origin` — each a plain HTTPS URL string, **not** an array or a
  nested object. Missing/null/empty slots are simply absent; `img1_origin`
  is the thumbnail. Confirmed hosts so far: `base-ec2.akamaized.net` (the
  API) and `baseec-img-mng.akamaized.net` (the public shop page) — both
  are allowlisted in `next.config.mjs`'s `images.remotePatterns`.
- `item_id`, `title`, `price`, `stock` come back as expected under those
  exact names.

Also confirmed — this time against BASE's own published API reference
(`docs.thebase.in/docs/api/items/detail`, mirrored at
`gist.github.com/baseinc/9912650`; both blocked from this sandbox's egress
proxy, reached via web search cache instead):

- **`GET /1/items/detail/:item_id` — `item_id` is a URL *path* segment,
  not a query string parameter.** The code originally sent
  `GET /1/items/detail?item_id=...`, which BASE rejects with
  `{"error":"no_item_id","error_description":"item_idは必須です"}` — the
  literal error seen in testing — because the path segment BASE actually
  reads is empty. Fixed in `getItem()` to build
  `` `/items/detail/${encodeURIComponent(itemId)}` `` instead.
- `visible` (1 = visible, 0 = hidden) is a real field on this response —
  `mapItem()`'s `pick(raw, "visible", ...)` already checked this name
  first, so no change needed there.
- Variation stock comes back as **`variation_stock`**, not `stock` —
  `mapItem()` now checks that name first (kept `stock` as a fallback).
- Documented error codes for this endpoint: `access_denied`,
  `invalid_request`, `invalid_scope`, `no_item_id`, `no_item` — the last
  two are exactly the "item genuinely isn't accessible" cases `getItem()`
  already treats as skippable (see below), not a request-shape bug.

Still unverified (checked via `pick()`'s plausible-name fallback in
`mapItem()`, same as before): `item_url` and the description field. If
either turns out wrong, `mapItem()`'s diagnostic warning (below) will show
the real key on the next mismatch.

- `GET /1/items` (paginated with `offset`/`limit`) is treated as a shop
  inventory list, not a full-text search API — `search()` pages through the
  catalog (up to 1000 items, 60s in-memory cache) and filters by
  title/description client-side, matching how the mock client behaves.
  If BASE's `/1/items` *does* support a server-side keyword param, that's a
  pure optimization to add later, not a correctness fix.
- `GET /1/items/detail/:item_id` for a single item — used only by flows
  that need one full item (URL paste, generate/publish a feature). `search()`
  never calls this: the list endpoint alone carries what `/admin/search`
  needs, so hydrating every result via `/items/detail` would be pure N+1.
- `mapItem()` checks several plausible field-name variants for whatever's
  still unverified above, and **logs a console warning** —
  `[BASE mapItem] unexpected item shape` — whenever a required field (id,
  price, or images) still comes back empty after that. It dumps the full
  raw item as JSON (not just key names). Now that images/title/price/stock
  are confirmed, this should stay quiet for normally-shaped items — if it
  fires, something is genuinely off (or BASE changed the shape), and the
  dumped JSON shows exactly what to adjust.
- `getItem()` treats a 400/403/404 from `/items/detail` as "this one item
  isn't accessible right now" (sold-out/hidden/deleted items can plausibly
  do this even though they were just in the list response) and returns
  `null` for it — logged as a warning, not thrown. Any other error (401,
  5xx, network) still throws, since that's a real problem worth surfacing.
  `getItems()` uses `Promise.allSettled` over `getItem()`, so one bad
  `item_id` in a batch (URL paste, generating a feature from a multi-item
  selection) never erases every other item that fetched fine — check
  `[BASE getItems] failed for item_id=...` in server logs if a selection
  comes back smaller than expected.

## Where each item plugs in

| Concern | File |
|---|---|
| OAuth endpoints, token persistence/refresh | `lib/base/oauth.ts` |
| OAuth start/callback routes | `app/api/base/oauth/start/route.ts`, `.../callback/route.ts` |
| Search/list + field mapping | `lib/base/client.real.ts` |
| Public-page BASE data (no token needed there) | `lib/features/baseSync.ts`, `app/features/[slug]/page.tsx` |
