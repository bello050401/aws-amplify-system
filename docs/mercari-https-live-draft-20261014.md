# HTTPS private draft acceptance — 2026-10-14

## Verified live

- A fresh user-provided HAR was validated with Self and OwnShops and installed into the existing staging-only session secret. Its expiry was 2026-10-14 10:43:36 JST. No credential values are recorded here.
- From the deployed BELLO EC listing screen, inventory `57b4b2b5-d6ad-435a-b303-5d412405a44c` (B005105, THONET armchair) was prepared for a private test at JPY 99,999, quantity 1, dining-chair category, no optional brand. Existing inventory facts were used; the inventory master was not changed.
- The BELLO server uploaded one inventory image, created a draft, updated it, verified its full readback, and persisted the private-draft link. These were server-side HTTPS operations; the Shops browser was used only to view the result afterward.
- Image receipt: `2JY8AHwXRsbmcyECAhHGhZ`, reserved 2026-10-14T00:49:05.415Z.
- Draft receipt: `2JY8ARTArbB7xQFktaAXRK`, creation reserved 2026-10-14T00:50:19.836Z. The workflow enforced the shared interval between writes.
- BELLO displayed “Shopsに下書きを保存し、内容を確認しました。” Shops showed the same image, title, description, JPY 99,999, quantity 1, category and fixed shipping values, with “この商品は下書きです”. No public listing was created.
- Local screenshot: `C:/Users/win/Documents/Codex/2026-10-14/mercari-https-proof/shops-private-draft.png`.

## Publication review issue and fix

The live new draft returned `maxQuantityPerOrderConfig: null`. The publication request builder required an object with `configuredValue: null`, as found in the older product capture, and rejected the new draft. The builder now accepts an explicit null for drafts only. Missing, malformed or configured purchase limits remain rejected. Published-product parsing remains unchanged.

The contract, publication, stopping and reopening suites passed (33 tests), and TypeScript checking passed. Deployment and live publication-review acceptance of this fix remain to be recorded.

## Remaining acceptance

- Review this existing draft; do not create it again.
- Public listing requires the user's immediate confirmation of the actual product and price. Publish, stop, and reopen have not yet been demonstrated end-to-end through BELLO.
- Long-term session renewal is not established. The new HAR contains no sign-in/token-refresh requests and no refresh token. The displayed expiry is a real limit, not proof of sustained login.
- Other condition mappings and optional brand submission remain disabled by the current runtime. Do not silently replace the user's selections.
- Automation remains paused. BASE and Next Engine were not changed.
