# BELLO Mercari Shops local read bridge (preparation)

This independent PC module queues **read-only checks for an existing product ID** on one shop account. It has no create, update, publish, stop, or image upload method. The code now includes an ADMIN-authenticated BELLO HTTPS GET/POST bridge, but the new cloud models and route have not been deployed or tested against a signed-in PC profile. Plain `run-read` records `CONNECTOR_NOT_CONFIGURED`. The opt-in `--browser-read yes` reader is limited to the observed exact edit screen and always leaves privacy, quantity, and image identity unobserved. It has not been run against a signed-in Shops account.

Node.js 24 or newer is required because the worker imports the shared TypeScript comparison function directly. No package installation is needed for queue tests; the optional visible browser launcher needs an existing Playwright installation and Chrome.

The known B005795 proof product must be reused. Do not enqueue a new-product operation. The queue root stores one non-secret account binding, immutable read requests, and sanitized result codes/comparisons. The first account binds the root; another account is rejected. A failed read becomes `UNKNOWN`, an expired session becomes `AUTH_REQUIRED`, and both preserve the same remote ID. Runs are explicit and read-only; there is no automatic retry. The worker accepts only an exact-product observation with both account and remote ID matching before it promotes field or private-state observations.

## One-time separate login

The current Codex in-app browser session is not attached to this module. For a future reviewed reader, the merchant can open a **separate dedicated Chrome profile** using:

```powershell
node src/cli.mjs open-login --profile "C:\Users\win\AppData\Local\BELLO\MercariBridge\ChromeProfile" --playwright "C:\path\to\node_modules\playwright\package.json"
```

The merchant logs in in the visible official Shops window and closes it when finished. The module does not extract cookies, copy the in-app browser session, handle the password, or send login data to BELLO. Chrome itself may retain the new browser session in this local profile; protect that Windows profile accordingly. This command prepares an independent session only. It does not make a Shops reader available or prove that automation is permitted.
The launcher creates a marker in an empty profile directory and refuses a non-empty unmarked directory, so an existing Chrome or in-app browser profile cannot be attached accidentally.

After that login, `open-existing` can reopen the **same** dedicated profile and navigate only to the observed exact-ID edit path. It binds `--root` to `--shop` and rejects a different shop later. It reports `AUTH_REQUIRED` for a sign-in redirect or `NAVIGATED_UNVERIFIED` for an exact URL; neither is a field or privacy confirmation. Close the browser after inspection. Its arguments are `--root`, `--profile`, `--playwright`, `--shop`, and `--remote`. No selector or form action is implemented.

```powershell
node src/cli.mjs open-existing --root "C:\Users\win\AppData\Local\BELLO\MercariBridge\Queue" --profile "C:\Users\win\AppData\Local\BELLO\MercariBridge\ChromeProfile" --playwright "C:\path\to\node_modules\playwright\package.json" --shop "<observed-shop-id>" --remote "<existing-product-id>"
```

## Queue contract

`enqueueExistingRead(root, { accountReference, inventoryCode, remoteId, expectedFields })` stores a `READ_EXISTING` job. `runExistingRead(root, accountReference, jobId, reader)` calls the injected reader at most once for the exact ID and stores only comparison outcomes. A reader may return `{kind: "AUTH_REQUIRED"}` or `{kind: "OBSERVED", observation}`; the latter must identify the exact account and product. An absent/failed reader is never treated as success. A crashed lock remains for manual inspection, with no automatic replay.

The observed UI edit path is `/seller/shops/{shopId}/products/{productId}/edit`. The edit screen alone has no non-public label; privacy came from the saved-product list row followed by exact-ID edit read-back. This module does not infer privacy from the edit page or invent selectors. The available browser surface has no authenticated HTTP capture. Before a real reader can be connected, it needs a reviewed same-account exact-ID navigation and field locator contract, a correlated private list result, a supported session attachment, and a way to return `AUTH_REQUIRED` without saving credentials. The existing BELLO photo station processes images, and the development orchestrator's Playwright worker is staging QA; neither provides this Shops reader.

The current partial browser reader only checks the observed 商品管理 heading and 公開設定に進む button, then reads fields whose parent label uniquely names 商品名, 商品の説明, 商品管理コード, or 販売価格. Duplicate or missing labels leave the field unobserved. It checks both the field extraction document URL and the final browser URL; a redirect discards the fields. It never clicks a save control. The edit screen's two spinbuttons have no proven label association, so quantity remains unobserved. Use `run-read --browser-read yes --profile ... --playwright ...` only after a merchant signs in to the **separate** profile and approves this read path; no signed-in run was performed in this change. The result can only be incomplete until the list-row privacy and image/quantity evidence are added.

Run isolated contract tests with `npm test` from this directory. No external network or browser is used by tests.

## Prepared BELLO connection (maintainer workflow, not merchant handoff)

The PC's BELLO login uses a **second dedicated Chrome profile**, separate from the Shops profile. The administrator signs in normally at BELLO's `/inventory/login`. Playwright's `browserContext.request` uses that same BELLO browser context's cookies for HTTPS requests to the pinned BELLO origin. No fixed device key, saved password, copied cookie, or Shops session is sent to BELLO. Redirects are not followed. The server requires the `ADMIN` group and the exact `requestedBy` owner on both the existing binding and read request before returning a small `READ_EXISTING` payload or accepting one sanitized result. The POST also requires exact same origin and a custom header. The isolated Next Engine app rejects this route.

The local commands prepared for a later managed PC launcher are `open-bello-login` (visible normal login, using `--bello-origin`, `--bello-profile`, `--playwright`) and `run-cloud-read` (one explicit existing-ID read, adding `--request`, `--root`, and optionally `--browser-read yes --shops-profile`). `run-cloud-read` first fetches one owned request, reads the exact existing Shops ID once, then reports only status/reason/comparison enums and its attempt ID. Without `--browser-read yes`, it reports `CONNECTOR_NOT_CONFIGURED`. The BELLO receipt always says `listingConfirmed: false`.

These are developer primitives. Do not ask the merchant to run a CLI. Before using them with real data, deploy the new models/route, provide a visible PC launcher, sign in to BELLO and Shops separately through their own official pages, and verify the live HTTPS cookie/origin behavior. The current code does not prove authenticated browser reading, private state, images, listing, or publication.
