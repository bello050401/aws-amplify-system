import assert from "node:assert/strict";

// Offline signing only. A real AWS credential must never be needed by this test.
process.env.AWS_ACCESS_KEY_ID = "PREVIEW_TEST_ONLY";
process.env.AWS_SECRET_ACCESS_KEY = "PREVIEW_TEST_ONLY";
delete process.env.AWS_SESSION_TOKEN;

async function main() {
  const { signInventoryPreviews, signInventoryListKey } = await import("../lib/inventory/listImageUrls");
  const { normalizeImageRecord } = await import("../lib/inventory/imageTypes");
  const images = [normalizeImageRecord({ storageKey: "inventory/test/original.jpg", thumbnailKey: "inventory/test/small.jpg", mediumKey: "inventory/test/medium.jpg", sortOrder: 0 })];
  const urls = await signInventoryPreviews(images);
  assert.deepEqual(Object.keys(urls).sort(), ["inventory/test/medium.jpg", "inventory/test/small.jpg"]);
  assert.equal(urls[images[0].storageKey], undefined, "Do not prefetch or sign the original when previews exist");
  for (const value of Object.values(urls)) {
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
    assert.equal(url.searchParams.get("response-cache-control"), "private, max-age=900");
  }
  assert.equal(await signInventoryListKey("other/private.jpg"), null);
  assert.equal(await signInventoryListKey("inventory/../private.jpg"), null);
  const fallback = await signInventoryPreviews([normalizeImageRecord({ storageKey: "inventory/test/legacy.jpg", sortOrder: 0 })]);
  assert.ok(fallback["inventory/test/legacy.jpg"], "Legacy records without derivatives remain visible");
  console.log("preview signing: private 15-minute URLs, preview-only, legacy fallback, unsafe keys rejected");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
