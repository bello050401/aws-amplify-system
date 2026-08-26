# BASE API — what's confirmed vs. what's a placeholder

This system talks to BASE through a single abstraction (`lib/base/`), specifically
so that once the real API details below are confirmed, only `lib/base/client.real.ts`
and `lib/base/oauth.ts` need to change — nothing else in the app imports BASE's
wire format directly.

**Current state: `BASE_USE_MOCK=true` by default.** The mock client
(`lib/base/client.mock.ts`) serves fixture data so the full search → select →
generate → preview → publish flow can be built, run, and demoed today. Do not
set `BASE_USE_MOCK=false` in any real environment until every item below is
checked off — the endpoint paths and field names currently in
`client.real.ts` / `oauth.ts` are best-effort placeholders based on BASE's
publicly known API host, not verified responses.

Why this file exists: the assistant building this system could not reach
`developer.thebase.in` or `api.thebase.in` from its environment (both are
blocked by network egress policy there), so none of the items below could be
confirmed against the live docs. Whoever has a working BASE API app should
fill this in from real request/response pairs (Postman, curl, or the app's
own logs) rather than the docs site if that's faster.

## Checklist

- [ ] **OAuth2 endpoints** — confirm the exact authorize + token URLs
      (`lib/base/oauth.ts` currently assumes `https://api.thebase.in/1/oauth/token`)
- [ ] **Scope name** — confirm `read_items` is the literal scope string BASE expects
- [ ] **Refresh flow** — confirm `grant_type=refresh_token` param shape and the
      response field names (`access_token` / `refresh_token` / `expires_in`?)
- [ ] **Search/list endpoint** — path, whether it supports a free-text keyword
      param, pagination shape (offset/limit vs. cursor)
      - If BASE's search doesn't do free-text well: fall back to listing +
        caching the full catalog and filtering server-side, exactly like
        `MockBaseApiClient.search()` already does — this is a drop-in swap.
- [ ] **Item detail endpoint** — path + exact response field names for:
      item id, title, price, description, images (which resolution?),
      stock, variations (color/size label field), item URL, publish/hidden
      status field and its true/false values, brand/maker field (only if
      BASE actually exposes one — see spec §8: never invent this)
- [ ] **Batch fetch** — does BASE support fetching multiple items in one
      call, or is per-id sequential fetching (current placeholder) the
      only option?
- [ ] **Rate limits** — requests/sec or /day, to size the Phase 2
      `BaseItemCache` sync interval sensibly

## Where each item plugs in once confirmed

| Item | File |
|---|---|
| OAuth endpoints, refresh shape | `lib/base/oauth.ts` |
| Search/list path + params | `lib/base/client.real.ts` → `search()` |
| Item detail path + field mapping | `lib/base/client.real.ts` → `mapItem()` |
| Batch fetch | `lib/base/client.real.ts` → `getItems()` |
