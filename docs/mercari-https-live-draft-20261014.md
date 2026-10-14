# HTTPS private draft acceptance — 2026-10-14

## Verified live

- A fresh user-provided HAR was validated with Self and OwnShops and installed into the existing staging-only session secret. Its expiry was 2026-10-14 10:43:36 JST. No credential values are recorded here.
- From the deployed BELLO EC listing screen, inventory `57b4b2b5-d6ad-435a-b303-5d412405a44c` (B005105, THONET armchair) was prepared for a private test at JPY 99,999, quantity 1, dining-chair category, no optional brand. Existing inventory facts were used; the inventory master was not changed.
- The BELLO server uploaded one inventory image, created a draft, updated it, verified its full readback, and persisted the private-draft link. These were server-side HTTPS operations; the Shops browser was used only to view the result afterward.
- Image receipt: `2JY8AHwXRsbmcyECAhHGhZ`, reserved 2026-10-14T00:49:05.415Z.
- Draft receipt: `2JY8ARTArbB7xQFktaAXRK`, creation reserved 2026-10-14T00:50:19.836Z. The workflow enforced the shared interval between writes.
- Update receipt: the same draft, reserved 2026-10-14T00:51:33.433Z, acknowledged. Consecutive reservations were approximately 74 seconds apart.
- BELLO displayed “Shopsに下書きを保存し、内容を確認しました。” Shops showed the same image, title, description, JPY 99,999, quantity 1, category and fixed shipping values, with “この商品は下書きです”. No public listing was created.
- Local screenshot: `C:/Users/win/Documents/Codex/2026-10-14/mercari-https-proof/shops-private-draft.png`.

## Publication review issue and fix

The live new draft returned `maxQuantityPerOrderConfig: null`. The publication request builder required an object with `configuredValue: null`, as found in the older product capture, and rejected the new draft. The builder now accepts an explicit null for drafts only. Missing, malformed or configured purchase limits remain rejected. Published-product parsing remains unchanged.

The contract, publication, stopping and reopening suites passed (33 tests), and TypeScript checking passed. Commit `c44127f` was deployed to staging in Amplify job 421 (BUILD/DEPLOY/VERIFY all SUCCEED). The actual BELLO screen subsequently reached the publication review showing the correct title, JPY 99,999, quantity 1 and one image, with “この内容で出品する”. No public write was sent.

The review builder also succeeded against a fresh HTTPS read of the actual saved draft after the fix (read-only; no publication request sent). A separate UI correction refreshes the preparation receipt after successful draft saving, removes obsolete “authentication/contract waiting” text, and distinguishes review failures without claiming an uncertain prior operation never happened.

UI commit `7d33a9f` was deployed in staging job 422, also BUILD/DEPLOY/VERIFY all SUCCEED. The publication-review screenshot is `C:/Users/win/Documents/Codex/2026-10-14/mercari-https-proof/bello-publication-review.png`.

The user explicitly approved B005105 at JPY 99,999, quantity 1: publish, stop, reopen the same product, stop again, at least 30 seconds apart, ending non-public. The reply was “この商品・価格でテストしてよい”. This approval remains valid for this exact test; do not ask for it again. Preserve this draft and image; do not repeat creation on resumption.

On resumption, the clock was 2026-10-14T12:27:24Z (21:27 JST), after the stored session's expiry. BELLO's read-only status check returned “メルカリShopsの再認証が必要です”. The supplied HAR still had its 09:44:08 JST modification time. No public write was attempted. DynamoDB receipts still contained only the acknowledged image, draft creation, and draft update above, with no public-product receipt. The user was asked once to refresh the authenticated HAR locally. Resume the already-approved cycle after safe import and shop verification; the block is expired authentication, not missing test approval.

Local screenshot: `C:/Users/win/Documents/Codex/2026-10-14/mercari-https-proof/bello-approved-test-auth-required.png`.

## Approved live publication lifecycle — completed

The user provided a refreshed HAR saved at 2026-10-14 21:29:31 JST. Its session was verified against the exact shop, then imported into the existing staging-only secret (expiry 22:28:49 JST). This capture has no token/refresh endpoint request or refresh-token grant. No authentication material was printed or committed.

All four approved writes were initiated from the deployed BELLO EC listing UI and executed by the server over HTTPS. Shops UI was used only for reading the result. Product `2JY9REopKfLdpCfQKvU4yf` was created once and reused for the entire cycle:

| Operation | Reservation time (UTC) | Persisted receipt |
| --- | --- | --- |
| Publish | 2026-10-14T12:31:04.878Z | PRODUCT_ACKNOWLEDGED |
| Stop | 2026-10-14T12:32:56.118Z | PRODUCT_STOP_VERIFIED |
| Reopen | 2026-10-14T12:34:08.334Z | PRODUCT_REOPEN_VERIFIED |
| Final stop | 2026-10-14T12:35:34.937Z | PRODUCT_STOP_VERIFIED |

Reservation intervals were 111.240, 72.216, and 86.603 seconds. An earlier stop click was blocked by the shared send window and made no write; after the window elapsed, the stop succeeded. The reservation deadline plus minimum interval intentionally provides a conservative separation.

The UI changed to “出品中 / 出品停止”, then “出品停止中 / 出品内容を確認”, then repeated these states on reopening and stopping. After a full page reload it still showed “出品停止中”. A separate fresh HTTPS read at 2026-10-14T12:36:44.081Z returned VERIFIED, STATUS_UNOPENED, JPY 99,999, quantity 1, one image, and the correct BELLO management code. The persisted product link also has STATUS_UNOPENED. The final product is non-public.

Proof directory: `C:/Users/win/Documents/Codex/2026-10-14/mercari-https-proof/`; `lifecycle-receipts.json`, `bello-published.png`, `bello-reopened.png`, and `bello-final-stopped.png` contain no authentication data. No additional public cycle is needed for this acceptance item.

The older PC section's generic “BELLO出品記録なし” label was misleading after a successful HTTPS listing. Its heading and empty label now explicitly identify PC records and direct HTTPS status checks to the HTTPS section. This is a display-only correction; the legacy PC workflow remains available.

Display correction commit `7b81916` passed `tsc --noEmit` and `git diff --check`, then deployed to staging in Amplify job 423 (BUILD/DEPLOY/VERIFY all SUCCEED). The actual reloaded BELLO page showed “メルカリShops PC方式の出品記録” and the separate HTTPS status instructions. No listing operation was repeated for this text-only deployment.

## Final acceptance update

- The approved lifecycle is complete, including final non-public readback and persistence. The draft was consumed by publication; keep the existing product link and do not create another draft or repeat this cycle without a new reason.
- The later user-provided HAR saved at 2026-10-14 13:50:31 UTC contains the actual refresh exchange. Server-only HTTPS renewal is now implemented and deployed in job 424 (`39b68dd`). The BELLO screen initiated one successful live renewal at 14:12:08 UTC; the rotated session was persisted in Secrets Manager and verified after page reload. The automatic near-expiry decision is tested. Long-term uninterrupted login is not a guarantee.
- All six observed condition mappings and optional master-validated brand submission are implemented and covered by contract/readback tests. The live product cycle above was CONDITION_CLEAN with no brand; other combinations were not sent as live product mutations.
- See `mercari-https-renewal-20261014.md` for the final renewal proof and exact verified scope. The current product remains non-public.
- Automation remains PAUSED. BASE and Next Engine were not changed. Only the authorized staging environment was deployed.
