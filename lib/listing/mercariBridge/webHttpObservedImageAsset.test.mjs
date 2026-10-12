import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { buildObservedImageAssetRequest,
  parseObservedImageAssetResponse,
  prepareObservedJpeg } from "./webHttpObservedImageAsset.ts";

const jpeg = Uint8Array.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
const digest = createHash("sha256").update(jpeg).digest("hex");

test("observed image multipart uses the captured operation, map and JPEG part", async () => {
  const request = buildObservedImageAssetRequest(jpeg, digest);
  assert.equal(request.preparedJpegSha256, digest);
  const fields = [...request.body.entries()];
  assert.deepEqual(fields.map(([key]) => key), ["operations", "map", "1"]);
  const operations = JSON.parse(fields[0][1]);
  assert.equal(operations.operationName, "CreateImageAsset");
  assert.deepEqual(operations.variables,
    { input: { file: null, protectionKind: "none", public: true } });
  assert.deepEqual(JSON.parse(fields[1][1]),
    { "1": ["variables.input.file"] });
  assert.equal(fields[2][1].name, "blob");
  assert.equal(fields[2][1].type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await fields[2][1].arrayBuffer()), jpeg);
});

test("changed or non-JPEG bytes cannot be serialized", () => {
  assert.throws(() => buildObservedImageAssetRequest(jpeg, "0".repeat(64)),
    /IMAGE_BYTES_MISMATCH_NO_SEND/);
  assert.throws(() => buildObservedImageAssetRequest(
    Uint8Array.from([1, 2, 3, 4]), digest), /INVALID_JPEG_NO_SEND/);
});

test("the prepared JPEG is bounded and linked to original bytes", async () => {
  const original = new Uint8Array(await sharp({ create: {
    width: 2400, height: 1200, channels: 3,
    background: "#8a5522" } }).jpeg().toBuffer());
  const originalHash = createHash("sha256").update(original).digest("hex");
  const prepared = await prepareObservedJpeg(original, originalHash);
  const metadata = await sharp(prepared.preparedJpegBytes).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.ok(metadata.width <= 1600 && metadata.height <= 1600);
  assert.equal(prepared.originalSha256, originalHash);
  assert.equal(buildObservedImageAssetRequest(prepared.preparedJpegBytes,
    prepared.preparedJpegSha256).preparedJpegSha256,
  prepared.preparedJpegSha256);
  await assert.rejects(() => prepareObservedJpeg(original, "0".repeat(64)),
    /SOURCE_IMAGE_MISMATCH_NO_SEND/);
});

test("asset ID is accepted only from a clean 200 JPEG response", () => {
  const response = { data: { createImageAsset: {
    id: "asset_123", contentType: "image/jpeg", __typename: "ImageAsset" } } };
  assert.deepEqual(parseObservedImageAssetResponse(200, response),
    { remoteAssetId: "asset_123", contentType: "image/jpeg" });
  assert.equal(parseObservedImageAssetResponse(200,
    { ...response, errors: [{ message: "failed" }] }), null);
  assert.equal(parseObservedImageAssetResponse(401, response), null);
  assert.equal(parseObservedImageAssetResponse(200,
    { data: { createImageAsset: { id: "bad/id", contentType: "image/jpeg" } } }), null);
});
