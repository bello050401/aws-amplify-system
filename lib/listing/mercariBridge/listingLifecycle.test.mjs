import assert from "node:assert/strict";
import test from "node:test";
import { shopsActionForState, shopsAdminUrl, shopsLifecycle } from "./listingLifecycle.ts";

const withStatus = (status, externalListingId = null) =>
  ({ status, externalListingId });

test("a remote ID and a completed state are both needed for successful actions", () => {
  assert.equal(shopsLifecycle(null), "NOT_LISTED");
  assert.equal(shopsActionForState(shopsLifecycle(null), null, null), null);
  assert.equal(shopsActionForState(shopsLifecycle(null), null,
    { kind: "EXACT_ABSENCE" }), "CREATE");
  assert.equal(shopsLifecycle(withStatus("ACTIVE")), "UNKNOWN");
  assert.equal(shopsActionForState(shopsLifecycle(withStatus("ACTIVE")),
    withStatus("ACTIVE"), null), null);
  assert.equal(shopsLifecycle(withStatus("ACTIVE", "verified123")), "LISTED");
  assert.equal(shopsActionForState(shopsLifecycle(withStatus("ACTIVE", "verified123")),
    withStatus("ACTIVE", "verified123"), null), null);
  assert.equal(shopsActionForState(shopsLifecycle(withStatus("ACTIVE", "verified123")),
    withStatus("ACTIVE", "verified123"), { kind: "EXACT_PRODUCT",
      remoteId: "verified123", visibility: "PUBLIC" }), "STOP");
  assert.equal(shopsActionForState(shopsLifecycle(withStatus("ACTIVE", "verified123")),
    withStatus("ACTIVE", "verified123"), { kind: "EXACT_PRODUCT",
      remoteId: "anotherProduct", visibility: "PUBLIC" }), null);
  assert.equal(shopsLifecycle(withStatus("ENDED", "verified123")), "UNKNOWN");
  assert.equal(shopsActionForState(shopsLifecycle(withStatus("ENDED", "verified123")),
    withStatus("ENDED", "verified123"), { kind: "EXACT_PRODUCT",
      remoteId: "verified123", visibility: "PRIVATE" }), null);
});

test("private, in-flight and unknown outcomes cannot be replayed", () => {
  const listing = withStatus("PAUSED", "private123");
  assert.equal(shopsLifecycle(listing), "UNKNOWN");
  assert.equal(shopsActionForState(shopsLifecycle(listing), listing,
    { kind: "EXACT_PRODUCT", remoteId: "private123", visibility: "PUBLIC" }), null);
  for (const kind of ["CREATE", "STOP", "RELIST"]) {
    const inFlight = shopsLifecycle(listing, { kind, phase: "RUNNING" });
    assert.equal(inFlight, kind === "STOP" ? "STOPPING" : "CREATING");
    assert.equal(shopsActionForState(inFlight, listing, null), null);
    assert.equal(shopsLifecycle(listing, { kind, phase: "UNKNOWN" }), "UNKNOWN");
  }
  assert.equal(shopsLifecycle(withStatus("ERROR", "private123")), "UNKNOWN");
  assert.equal(shopsLifecycle(withStatus("ACTIVE", "../wrong")), "UNKNOWN");
});

test("admin product links are built only from bounded IDs", () => {
  assert.equal(shopsAdminUrl("shop123", "product456"),
    "https://mercari-shops.com/seller/shops/shop123/products/product456/edit");
  assert.equal(shopsAdminUrl("shop123", "../wrong"), null);
  assert.equal(shopsAdminUrl("https://evil.example", "product456"), null);
});
