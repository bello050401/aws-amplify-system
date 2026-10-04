import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectExistingImage, MAX_SHOPS_IMAGE_BYTES, prepareExistingImageFile } from "../src/prepareExistingImage.mjs";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 1, 2, 3, 0xff, 0xd9]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("one pinned BELLO JPEG prepares a stable local file without changing its bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-image-proof-"));
  try {
    const sourcePath = join(root, "signed-download.jpg");
    const outputDirectory = join(root, "ready");
    await writeFile(sourcePath, jpeg);
    const options = { sourcePath, outputDirectory, inventoryCode: "B005795", expectedSha256: hash(jpeg) };
    const prepared = await prepareExistingImageFile(options);
    assert.equal(prepared.mimeType, "image/jpeg");
    assert.equal(prepared.byteLength, jpeg.length);
    assert.match(prepared.filename, /^B005795-[a-f0-9]{16}\.jpg$/);
    assert.deepEqual(await readFile(prepared.path), jpeg);
    assert.deepEqual(await prepareExistingImageFile(options), prepared, "an exact duplicate is reused, not replaced");
    await writeFile(prepared.path, Buffer.from("changed"));
    await assert.rejects(prepareExistingImageFile(options), /Existing proof file differs/);
    assert.equal((await readFile(prepared.path)).toString(), "changed", "a collision is never overwritten");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed bytes, unsupported format and a file above 8 MB are refused before staging", async () => {
  assert.throws(() => inspectExistingImage(Buffer.from("secret"),
    { inventoryCode: "B005795", expectedSha256: hash(Buffer.from("secret")) }), /JPEG or PNG/);
  assert.throws(() => inspectExistingImage(jpeg,
    { inventoryCode: "B005795", expectedSha256: "0".repeat(64) }), /do not match/);
  const tooLarge = Buffer.concat([jpeg.subarray(0, -2), Buffer.alloc(MAX_SHOPS_IMAGE_BYTES), jpeg.subarray(-2)]);
  assert.throws(() => inspectExistingImage(tooLarge,
    { inventoryCode: "B005795", expectedSha256: hash(tooLarge) }), /size/);
});
