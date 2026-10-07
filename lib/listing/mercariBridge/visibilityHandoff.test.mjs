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
  for (const id of ["DD273C1E-9B2A-4013-ACC6-C445A481FAB8",
    "5B0F3587-CBBB-4C09-AE78-595B2B3E353F",
    ["5b0f3587-cbbb-4c09-ae78-595b2b3e353f"]])
    assert.equal(buildVisibilityPcJob({ ...inventory, id },
      { ...draft, inventoryId: id }, { ...listing, inventoryId: id }), null);
  for (const code of ["B005659", "B005413", "TEST_B005413_B63EF3F86211FFE0F890D81E"])
    assert.equal(buildVisibilityPcJob({ ...inventory, sku: code }, draft, listing), null);
  for (const id of ["2JWp7EJx6aqKfn6dTXc5Q9", "2JToDtSgGowzUwnwe9hgHU"])
    assert.equal(buildVisibilityPcJob(inventory, draft,
      { ...listing, externalListingId: id }), null);
  assert.equal(buildVisibilityPcJob(inventory, draft,
    { ...listing, status: "PAUSED" }), null);
  assert.equal(buildVisibilityPcJob(inventory, draft,
    { ...listing, listingDraftId: "stale-draft" }), null);
});
