# BELLO independent shop listing

The inventory listing page now has a **BELLO自社サイトへ出品** panel for ADMIN and EDITOR. The panel reads the saved common listing draft and its selected images. It previews the title, description, price, quantity and image count, then transfers images and creates or updates a **draft** on the owner-only BELLO shop.

## Scope and boundaries

- Fixed destination: `https://bello-interior-independent.misty-loom-0065.chatgpt.site`.
- A source inventory ID maps to `externalId=inventory:<id>`. Retries do not create a second product.
- Only title, description, selling price, SKU, assigned quantity and selected images are transferred. Supplier information, acquisition cost, customer data and internal notes are excluded.
- Preview expires after 15 minutes. Source changes and remote revision changes require a new preview. Image receipts are signed and bound to that preview.
- Existing remote variants are rejected. The connector cannot overwrite variant stock with one quantity.
- Transfers always save a draft, including updates. They do not publish a product or change the website audience.
- Inventory master quantities and other sales channels are unchanged. Automatic order-to-inventory reconciliation is **not implemented**. Reserve quantities operationally before public trading.
- No payment integration or email provider activation is included.

## Connection configuration

The default is disconnected. With `BELLO_SHOP_CONNECTION_ENABLED` unset or `0`, preview does not call Secrets Manager or the shop API.

The prepared configuration requires:

1. One dedicated BELLO API key scoped to `products:read` and `products:write` only.
2. The private Sites service access token. This passes the site gateway but does not grant BELLO owner/admin access.
3. A dedicated Secrets Manager secret named `bello/independent-shop-connection` in `us-west-2`, with the JSON shape below. Secret values must be provisioned securely, never committed or printed.

```json
{"enabled":true,"apiKey":"<dedicated BELLO key>","sitesServiceToken":"<private site service token>"}
```

4. The inventory SSR compute role receives `secretsmanager:GetSecretValue` on this exact secret ARN only. No wildcard access or client-side credentials.
5. Set the staging branch's non-secret `BELLO_SHOP_CONNECTION_ENABLED=1` and rebuild. `amplify.yml` propagates it only for app `d4hkkg7dty2du`, branch `claude/inventory-management-system-5vbvc7`.

For isolated local development, server-only `BELLO_SHOP_API_KEY` and `BELLO_SHOP_SERVICE_TOKEN` may replace the secret. Never prefix these with `NEXT_PUBLIC_`.

Credential creation, secret provisioning, permission changes and cloud rollout have not been performed in this change. Keep the shop owner-only. Obtain the required action-time authorization before issuing a persistent key through the management UI. Do not reuse existing BASE, Mercari, Yahoo or email credentials.

## Verification

```text
node scripts/qa/run-verify-with-server-only-noop.cjs scripts/verify-independent-shop.ts
npm run build
```

The focused suite checks authorization before data access, disabled connection, source ID mismatch, invalid stock, read-only preview, signed previews and receipts, expiration, source/remote changes, draft-only whitelisted payloads, duplicate prevention, variant rejection, fixed destination and HTTP partial failure handling. It uses synthetic data and mocked remote responses; it is not proof of a live cloud transfer.

Manual browser QA uses existing local E2E fixture authentication. The missing-image and excess-quantity errors were checked without real inventory mutations. Desktop and 390px layouts were checked, with no horizontal overflow in the new panel. This is browser viewport testing, not physical iPhone/Safari verification. Actual end-to-end cloud transfer remains to be checked after connection configuration.

## Delivery record

- Orchestrator intake: `task_ec761db6c135b1888d`.
- User explicitly authorized direct implementation and testing in this chat instead of the repository's mandatory Orchestrator execution path for this task.
- Actual implementation: Codex in an isolated worktree based on deployed commit `95986cba11709b444b57fc1688502ab503219b6c`. No Claude/eco execution is claimed.
- Existing checkout changes were preserved. No database schema or production/customer data was changed.

To disable transfers, set the secret's `enabled` to false. To stop even secret reads, set the branch switch to `0` and rebuild. Previously transferred drafts remain in the BELLO shop for owner review.
