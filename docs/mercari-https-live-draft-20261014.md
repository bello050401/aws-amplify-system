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

## Remaining acceptance

- Review this existing draft; do not create it again.
- The exact public lifecycle test above is approved and awaits refreshed authentication. Publish, stop, and reopen have not yet been demonstrated end-to-end through BELLO.
- Long-term session renewal is not established. The new HAR contains no sign-in/token-refresh requests and no refresh token. The displayed expiry is a real limit, not proof of sustained login.
- Other condition mappings and optional brand submission remain disabled by the current runtime. Do not silently replace the user's selections.
- Automation remains paused. BASE and Next Engine were not changed.
