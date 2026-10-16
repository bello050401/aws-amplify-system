# Yahoo Auctions personal-account preparation — 2026-10-15

## Scope and current limit

Requested location: below the Mercari Shops HTTPS section of BELLO EC listing.
Implemented: channel-specific editable preparation and persistent BELLO drafts.
Actual Yahoo listing, cancellation, relisting, photo upload and category selection
are **not connected to the BELLO web UI**. Authenticated HTTPS input reading was
verified from local Node on October 16; cloud execution is still unverified.
The remote listing button is disabled and the screen explicitly says that only
BELLO draft saving works.
Do not report this as completed automatic listing.

## Required connection method (user correction, 2026-10-15)

The user explicitly specified: 「apiではない。http法式にする」.
Implement the normal Yahoo Auctions website's observed HTTPS exchanges from the
BELLO server, using the user's personal seller account. A contracted listing API
is not the requested design or a prerequisite assumed by this project. Do not
change to browser-driven listing, a resident PC, cloud-browser listing or CSV
export without a new user instruction. Opening a browser to inspect the normal
form during development does not change the production execution method.

At the end of October 15, the missing evidence was Yahoo's actual authenticated request/response
sequence, not an unanswered API-contract question. No Yahoo HAR was found among
the local Desktop/Downloads HAR files checked in this turn. The existing Mercari
HARs are not Yahoo protocol evidence. The Yahoo homepage's normal 出品 link was
opened and redirected to Yahoo! JAPAN login; authentication has not been
confirmed as of that turn. The login tab was retained for normal sign-in.

Next, observe the real image-upload, form/category, confirmation, submission,
status, cancellation and relisting exchanges. Record verified operation meanings
separately from HTTP success codes; a 200 response or a saved BELLO draft alone
does not prove a Yahoo listing. Implement observed behavior only, with
server-side credential protection, expired-authentication handling, durable
result IDs and uncertain-result reconciliation before any retry. Do not assume
that a website session guarantees long-term authentication, and do not bypass
login challenges or anti-abuse controls.

Future public-listing tests require the user's Yahoo-specific target confirmation
(the earlier Mercari test approval does not authorize Yahoo publication).
Preserve the requested minimum 30-second interval between listing submissions.
Before exposing stop/relist, verify Yahoo-specific bid state, cancellation fees
and resulting listing IDs; these operations may differ from Mercari visibility
changes. Keep BASE and existing Mercari behavior unchanged.

## Authenticated page inspection — 2026-10-16

The user completed sign-in. The in-app browser displayed the personal seller's
normal 商品情報入力 page at
`https://auctions.yahoo.co.jp/sell/jp/show/submit?category=0`.
Only rendered form metadata and visible choices were inspected; no browser
cookies, hidden authentication values, passwords or confirmation codes were read.
No image, draft or public listing was submitted to Yahoo.

Observed form action: POST `https://auctions.yahoo.co.jp/sell/jp/show/preview`.
This is the confirmation-page form action, **not** a verified final-publication
endpoint or a complete captured POST body. JavaScript can add/transform fields,
so visible control names alone must not be treated as a tested wire payload.

Observed visible controls:

| Field | Form name / values |
| --- | --- |
| Title | `Title`, displayed maximum 65 characters |
| Condition | `istatus`: unused `new`, like new `used10`, no notable damage `used20`, slight damage `used40`, damage `used60`, bad `used80` |
| Quantity | `Quantity`, choices 1–9 in this account's current form |
| Origin | `loc_cd`; Saitama is `11` |
| Dispatch | `shipschedule`: 1–2 days `1`, 2–3 days `7`, 3–7 days `2` |
| Fixed price | `BidOrBuyPrice` |
| Closing date/hour | `ClosingYMD` is YYYY-MM-DD; `ClosingTime` is 0–23; the current form offered today through seven days later |
| Automatic relisting | `numResubmit`, 0–3; the account's form currently defaults to 3 |
| Automatic discount | `markdown_ratio`, 0/5/10/15/20/25/30 percent |

The shipping-payer selector has values `seller`/`buyer` but **no form name**;
similarly, the custom shipping-name input is not directly named. Do not equate
these DOM values with final POST parameters. The account defaults are buyer-paid
shipping, shipping price communicated after the auction, custom 家財おまかせ便,
Saitama and 3–7 days. BELLO's intended seller-paid shipping must be explicitly
checked at preview rather than inheriting the account's defaults. Also do not
inherit automatic relisting, discounts, paid promotion or payout-setting changes
without explicit selection.

The normal category link led to `/sell/jp/show/topsubmit?type=1`; the keyword
search form uses GET with visible `p` and `auccat` inputs. Category-list entries
are JavaScript controls, so their text does not establish a category-request
endpoint. No guessed category API has been added.

A Node HTTPS GET from this PC to the observed input-page URL, without browser
authentication, returned HTTP 302 to `login.yahoo.co.jp/config/login`. No redirect
query values or response body were logged. This confirms reachability and the
need for an authenticated session; it does not prove AWS-side access or listing.
The in-app browser session is not automatically available to BELLO's server.
The available browser tools do not expose a network-body/HAR export capability,
and the previous Chrome connection is currently unavailable. The next necessary
input at that point was a locally saved Yahoo HAR from normal Chrome. Start with the logged-in
input-page reload so server-side authenticated reading can be validated before
requesting any real publication. Do not bypass the browser-tool limitations or
assume the earlier Mercari HAR contains Yahoo authentication.

## User HAR and HTTPS probe — 2026-10-16

Received `C:/Users/win/Desktop/auctions.yahoo.co.jp.har` (3,732,686 bytes,
captured from 2026-10-16 02:49:34 UTC). It contains an authenticated successful
GET `/jp/show/submit?category=0`, its HTML and public Yahoo JavaScript assets.
This capture does NOT contain image-upload, preview, publication, cancellation
or relisting POSTs. Cookies are present; no new authentication capture is needed
merely to prove authenticated reading. Do not print or commit the HAR.

At 02:58:45 UTC the reusable Node client returned the expected authenticated
input form by HTTPS, with a live CSRF token and expected condition/quantity
choices. This was local Node, **not AWS**, and no browser was running the GET.
It does not establish long-lived authentication or renewal. The 24-hour HAR
import limit in the operator probe is a local validity check, not a claim about
Yahoo's cookie lifetime.

The captured HTML names the image endpoint `/img/images/new`. The captured
`uploadImage.min.js` builds multipart `files[0]`, `.crumb` from `img_crumb`, and
`need_thumbnail=1` for the first image. `dragdrop.min.js` consumes `images[0]`
with url/width/height plus `thumbnail`. This is captured source evidence, not
proof of a successful image POST from BELLO.

One direct HTTPS image probe used the saved B005105 photo on October 16 at
03:09:54 UTC. It returned **IMAGE_RESULT_UNKNOWN**; no retry was sent. The first
version did not retain status/MIME/validation-stage diagnostics, so its precise
failure cause cannot be recovered from the result. Do not call it a failed
upload (it may have created an unlisted asset), and do not replay it using a new
result filename. Subsequent code records only safe status/MIME class/stage data.
No listing/preview/publication POST was made by this HTTPS probe.

Operator evidence, outside Git:

- `C:/Users/win/Documents/Codex/2026-10-16/yahoo-http-proof/image-probe-20261016.json`
- Photo SHA-256 `44352dd7cf3b0c89542f8bb25a90868bd6bf9c1faa8e536aabe0570e1bf39a89`

### Normal Chrome observation, development only

Chrome connection became available. Its visible account name was
`Belloインテリア`. The ordinary website accepted the saved chair photo, category
selection and confirmation form. The agent reached `/sell/jp/show/preview` and
verified the actual rendered product preview:

- THONET トーネット アームチェア ダイニングチェア 1脚; one correct image.
- Fixed price 99,999 yen; quantity 1; no notable damage.
- Category 2084057261: 住まい、インテリア / 家具、インテリア / イス / ダイニングチェア.
- Seller-paid/free shipping; 家財おまかせ便; Saitama; dispatch 3–7 days.
- End displayed October 19, 2026 at 11:49 JST; auto-relist and paid promotion off.
- The preview's placeholder auction ID `1` is NOT an issued listing ID.
- The final “ガイドラインと上記規約等に同意して 出品する” button was NOT clicked.

This is browser-observed **pre-publication evidence**, not successful HTTPS
listing. It does not change the required production architecture. The user was
asked to overwrite the Desktop HAR with this new image/category/preview traffic;
analyze that saved file next. Keep the Chrome preview tab open (tab 725666925).
Screenshot:
`C:/Users/win/Documents/Codex/2026-10-16/yahoo-http-proof/yahoo-preview-unpublished.png`.

### New code and validation

- `lib/listing/yahooAuction/webHttpSession.ts`: server-only exact-destination
  GET and one image probe; private credentials; live form validation; bounded
  parsing; no redirects/retries/browser fallback; 401/403/429 stop.
- `scripts/probe-yahoo-http-from-har.ts`: explicit local authenticated read.
- `scripts/probe-yahoo-image-from-har.ts`: exclusive local attempt record before
  one image POST, then vetted result only. No listing or public submit method.
- Ten focused tests pass, including wrong destinations, malformed credentials,
  response limits, image multipart data and uncertain-result non-retry.
- TypeScript project check (`tsc --noEmit --incremental false`) passes.
- `parse5` 7.3.0 is used to parse returned HTML without executing JavaScript.
- Not deployed/connected to EC listing. No Yahoo credential has been stored in
  AWS; no IAM or production changes; BASE/Mercari unaffected.

Next: use the new capture to resolve the image response contract and implement
the exact preview request; then verify cloud-side authenticated execution and
connect the reviewed flow to BELLO. Publication/cancellation/relisting still
require actual successful operation evidence and Yahoo-specific public approval.

References checked for context (these do not replace observed HTTPS evidence):
- Yahoo official detailed rules, A26: https://guide-ec.yahoo.co.jp/notice/rules/auc/detailed_regulations.html
- Historical private listing API announcement (2012; not proof of current access): https://techblog.yahoo.co.jp/web/auctions/submit-api/
- AucTown support confirms its individually contracted Yahoo API: https://support.auctown.jp/hc/ja/articles/6679545880591

## 2026-10-16 updated HAR and HTTPS preview

The user's updated Desktop HAR (15,790,401 bytes, modified 03:20:59 UTC)
contains 450 entries. Relevant successful operations: image asset (107),
thumbnail processing (110), category selector (114), selected-category input
(219), and pre-publication confirmation (374). Both image responses omit the
optional `thumbnail` property; the second response uses string dimensions.
The parser was corrected from this actual evidence. The earlier direct image
probe remains UNKNOWN: its raw response was not retained and it was NOT retried.

At 2026-10-16 03:36 UTC, the Node HTTPS client fetched a fresh authenticated
form, posted to `topsubmit`, selected category 2084057261 via `show/submit`,
then posted to `show/preview`. It reused the existing browser-uploaded image.
The final HTML was checked against the requested title, description, photo,
99,999 yen, quantity 1, seller-paid 家財おまかせ便, Saitama, 3–7 days,
automatic relist off and zero optional fees. It passed. End time returned by
Yahoo was 2026-10-19T02:36:10Z (11:36:10 JST).

- Local evidence: `C:/Users/win/Documents/Codex/2026-10-16/yahoo-http-proof/preview-probe-20261016.json`.
- No new image upload, final listing, cancellation or relisting occurred.
- No captured CSRF/signature values were replayed; tokens come from fresh forms.
- Preview client is currently limited to the observed fixed-price, one-photo,
  seller-paid furniture configuration. It is not yet a general listing connector.
- Secret import is operator-only into a dedicated staging Secrets Manager
  secret. The AWS runtime receives read permission only. Secrets/HTML/HAR do not
  reach the browser, outputs or normal logs.
- Cookie longevity and renewal are not established. The 24-hour HAR freshness
  restriction applies only to import; stored sessions authenticate live. There
  is no invented refresh endpoint or browser fallback.
- Added authenticated BELLO connection-check action/button. Publication stays
  disabled until the complete server workflow and actual outcome are verified.
- 18 targeted tests and project TypeScript check pass before staging deployment.

### Staging acceptance of the server connection

- Commit `53e133bd4c94e1d400ae29c9627d52ecee358a65` deployed in Amplify job 429;
  BUILD, DEPLOY and VERIFY all SUCCEED. Only the authorized staging branch was
  pushed. Existing BASE/Mercari resources and runtime permissions were preserved.
- Dedicated Yahoo staging secret was created by CDK and imported from the user's
  HAR after an authenticated local read. A first import attempt before resource
  creation returned NOT_CONFIRMED; DescribeSecret confirmed it was not yet
  provisioned. Import succeeded after creation; no blind secret overwrite retry.
- At 2026-10-16 12:51:13 JST, the deployed EC page's authenticated
  `ヤフオク接続を確認` action read the encrypted session with the AWS compute role,
  performed the HTTPS input GET from AWS, and displayed the explicit success.
- Screenshot outside Git:
  `C:/Users/win/Documents/Codex/2026-10-16/yahoo-http-proof/bello-yahoo-cloud-connected.png`.
- This proves cloud authenticated **reading**. The earlier preview POST proof
  was local Node; AWS image/preview/publication writes remain unproven.
- Public-test approval question is pending: B005105, one chair, 99,999 yen,
  seller-paid shipping, final listing terms; wait at least 30 seconds before
  checking cancellation. Do not confirm a cancellation with bids or a fee.
- No Yahoo public listing was created in this turn. Chrome preview tab 725666925
  remains at confirmation for the concrete test; screenshot
  `C:/Users/win/Documents/Codex/2026-10-16/yahoo-http-proof/yahoo-preview-approval.png`.
- The deployed EC listing button remains disabled. Category/image/job bindings,
  full publication/stop/relist flow and durable send spacing still need work.

Remaining: verify AWS execution, connect image/category/preview results to each
inventory, obtain Yahoo-specific approval for a concrete public test, observe and
verify publication/cancellation/relisting, and implement durable result binding,
30-second spacing and ambiguous-result reconciliation. The earlier Mercari test
approval is not Yahoo public approval.

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
  array/photo order. Build 427 was cancelled before deployment to include the
  category UI clarification. Final code `cf3103d` deployed successfully in build
  428 (BUILD / DEPLOY / VERIFY all SUCCEED).
- Final live save returned the explicit success message at 2026-10-15 08:51:21
  JST. After a full page reload, 99,999 yen, quantity 1 and the category memo
  "家具・椅子" were restored with that same saved timestamp. The remote listing
  button remained disabled. Mercari's existing stop state remained visible.
- Screenshot: `C:/Users/win/Documents/Codex/2026-10-15/yahoo-auction-proof/yahoo-listing-saved.png`.
- Test inventory: `57b4b2b5-d6ad-435a-b303-5d412405a44c` (B005105 chair).
  Category and desired end time intentionally blank; no Yahoo listing was made.

## Authorized public HTTPS test, 2026-10-16 23:50-23:54 JST

The user explicitly approved B005105, one THONET chair, 99,999 yen,
seller-paid delivery, final listing terms and a cancellation check after at
least 30 seconds; no bid/fee acceptance. The response was not inferred from `f`.

- A fresh input/category/preview sequence and the observed final form handler
  were used. One local Node HTTPS POST to `/sell/jp/config/submit` at
  2026-10-16T14:50:22.660Z returned candidate ID `f1248612637`.
- The actual item page confirmed title, one chair, 99,999 yen, free shipping,
  ownership and zero bids. The first response alone was not called success.
- The served Yahoo client showed cancellation GET
  `/api/sell/v1/items/{id}/close/preview?operation=CANCEL`, then PUT
  `/api/sell/v1/items/{id}/close` with JSON
  `{ "hasCancelFee": false, "operation": "CANCEL" }` and the fresh preview
  response's `x-csrf-token`. This is the website's own HTTPS flow, not a
  contracted public API or browser automation production architecture.
- The real preview had isSubmitFeeCategory:false and empty feeInfo. The site's
  implementation interprets an omitted fee as zero. Bids were rechecked before
  sending, and the server receives hasCancelFee:false to reject late fee cases.
- One HTTPS cancellation was sent at 2026-10-16T14:54:13.918Z, 231 seconds after
  publication. The first probe reported RESULT_UNKNOWN during response handling;
  the response status/body were not retained, so the exact parse failure is not
  asserted. No second PUT was sent. A separate authenticated HTTPS read at
  14:54:45Z confirmed status:cancelled, bids:0, quantity:1, price:99999. The
  actual UI showed ended with no winner.
- The reusable client now ignores cancellation response bodies and reconciles
  the exact known item even after an empty response or lost acknowledgement.
- Durable local one-attempt files prevent repeated publication or cancellation.
  They are operator probes, not the production account-wide job/spacing store.
- Screenshots and sanitized result records are outside Git under
  `C:/Users/win/Documents/Codex/2026-10-16/yahoo-http-proof/`:
  `yahoo-https-published.png`, `yahoo-https-cancelled.png`,
  `publication-b005105-once.json`, `cancellation-f1248612637-once.json`,
  `cancellation-readback-f1248612637.json`.

Added a separate YahooAuctionListing result model, conditional refresh action,
and EC result display. An operator import verifies the exact ended test via
HTTPS and matches the saved BELLO preparation before creating its binding.
No stock, BASE or Mercari record is changed. Targeted Yahoo tests: 37 pass;
TypeScript passes. Staging deployment/UI acceptance to be recorded separately.

Not yet complete: full EC publish/cancel/relist orchestration, durable
account-wide send spacing and ambiguity recovery, category/image binding,
AWS mutation acceptance, general multi-image/auction mode and session renewal.
The public test above ran local server-side Node, not the AWS compute role.
The relist URL was observed; read-only input reports mode=oresubmit and the old
auction ID. No relist was submitted or authorized by this single-publication test.

### Delayed cancellation readback, 2026-10-17 JST

The subsequent owned item GET returned HTTP 404 with complete `__NEXT_DATA__`
item evidence: the exact auction ID, status cancelled, price 99,999, quantity 1,
zero bids and owner information. A generic 404 must not be treated as cancelled.
The parser now accepts 404 only with full matching owned cancellation evidence;
missing data, different IDs/accounts and open/closed statuses still fail.
Five targeted readback/cancellation tests pass. The operator import then verified
the remote state and conditionally created the YahooAuctionListing binding to
B005105. No second cancellation was sent.
