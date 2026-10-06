import assert from "node:assert/strict";
import test from "node:test";
import { buildVisibilityPcJob } from "./visibilityHandoff.ts";
import { exactVisibilityPcJob } from
  "../../../tools/bello-mercari-bridge/src/visibilityTransitionOnce.mjs";

const inventory = { id: "bd4850de-9156-4890-a821-cae75da5c8f7",
  sku: "B009999", quantity: 1 };
const draft = { id: "draft123", inventoryId: inventory.id,
  title: "Exact owned product", price: 45000 };
const listing = { inventoryId: inventory.id, listingDraftId: draft.id,
  channel: "MERCARI_SHOPS", status: "ACTIVE",
  externalListingId: "ownedProduct123", overrideTitle: null, overridePrice: null };

test("BELLO's no-send stop job is accepted by the PC boundary", () => {
  const job = buildVisibilityPcJob(inventory, draft, listing);
  assert.equal(job?.target.remoteId, listing.externalListingId);
  assert.equal(job?.target.priceYen, 45000);
  assert.equal(exactVisibilityPcJob(job), true);
  const relist = buildVisibilityPcJob(inventory, draft, listing, "RELIST");
  assert.equal(relist?.action, "RELIST");
  assert.equal(exactVisibilityPcJob(relist), true);
});

test("protected and stale BELLO records cannot export an executable stop job", () => {
  assert.equal(buildVisibilityPcJob({ ...inventory,
    id: "DD273C1E-9B2A-4013-ACC6-C445A481FAB8" },
  { ...draft, inventoryId: "DD273C1E-9B2A-4013-ACC6-C445A481FAB8" },
  { ...listing, inventoryId: "DD273C1E-9B2A-4013-ACC6-C445A481FAB8" }), null);
  assert.equal(buildVisibilityPcJob(inventory, draft,
    { ...listing, externalListingId: "2JWp7EJx6aqKfn6dTXc5Q9" }), null);
  assert.equal(buildVisibilityPcJob(inventory, draft,
    { ...listing, status: "PAUSED" }), null);
  assert.equal(buildVisibilityPcJob(inventory, draft,
    { ...listing, listingDraftId: "stale-draft" }), null);
});
