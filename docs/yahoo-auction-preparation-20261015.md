# Yahoo Auctions personal-account preparation — 2026-10-15

## Scope and current limit

Requested location: below the Mercari Shops HTTPS section of BELLO EC listing.
Implemented: channel-specific editable preparation and persistent BELLO drafts.
Actual Yahoo listing, cancellation, relisting, authentication, photo upload and
category selection are **not connected or verified**. The remote listing button
is disabled and the screen explicitly says that only BELLO draft saving works.
Do not report this as completed automatic listing.

The desired integration remains server-side HTTPS. No desktop browser or
resident-PC fallback was introduced. The user was asked whether they have Yahoo
listing API permission/contract and connection specifications; no answer has yet
been received. Public product endpoints and authentication must not be guessed.

Primary references checked:
- Yahoo official detailed rules, A26: https://guide-ec.yahoo.co.jp/notice/rules/auc/detailed_regulations.html
- Historical private listing API announcement (2012; not proof of current access): https://techblog.yahoo.co.jp/web/auctions/submit-api/
- AucTown support confirms its individually contracted Yahoo API: https://support.auctown.jp/hc/ja/articles/6679545880591

## Implemented

- Separate `YahooAuctionPreparation` model, keyed by inventory, with revisions.
- Own title, description, condition, fixed/auction format, price, quantity,
  category memo, desired end time in Japan and auto-extension. The actual
  category chooser remains visibly disabled until a connector is specified;
  users are not asked to enter internal category IDs.
- Server-loaded snapshot of common-draft image selection and shipping method.
- ADMIN/EDITOR action authorization; stock, sold status, source-version and
  conditional revision checks; uncertain acknowledgement reconciled by readback.
- Does not write Inventory, ListingDraft, Mercari or BASE records.
- No Yahoo credentials or outbound Yahoo requests are used by this feature.

## Checks and deployment

- Nine focused tests pass, including server-action persistence, lost
  acknowledgement, competing writes and reordered AWSJSON object keys.
- TypeScript check passes.
- Feature commit `313d27d`; build-memory fix `afdf4d1`; JSON-order fix `67e884b`.
- Only staging app `d4hkkg7dty2du`, branch
  `claude/inventory-management-system-5vbvc7` was targeted. Production untouched.
- Build 425 hit Node's approximately 2 GiB heap during type checking. Build 426
  succeeded with a 4 GiB heap on the unchanged STANDARD_8GB builder; checks remain
  enabled.
- Live UI verified placement and fixed/auction field switching. The first save
  persisted 99,999 yen / quantity 1 and restored after reload, but incorrectly
  reported a conflict because JSON object key ordering changed. This failure was
  reproduced by a regression test and fixed by semantic comparison retaining
  array/photo order. Final deployment and live acknowledgement verification are
  pending for the final combined build (427 was cancelled before deployment to
  include the category UI clarification).
- Test inventory: `57b4b2b5-d6ad-435a-b303-5d412405a44c` (B005105 chair).
  Category and desired end time intentionally blank; no Yahoo listing was made.
