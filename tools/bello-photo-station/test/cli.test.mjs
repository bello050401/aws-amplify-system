import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/cli.mjs";
import { makeSyntheticSourceJpeg } from "./testFixtures.mjs";

function stubFetch() {
  return async (url, init) => {
    if (init.method === "PUT") return { ok: true, status: 200 };
    const op = url.split("/").at(-1);
    const input = JSON.parse(init.body);
    if (op === "createPhotoBatch") return { ok: true, status: 200, json: async () => ({ ok: true, value: { batchId: "b1", batchCode: "PB-1", status: "CREATED" } }) };
    if (op === "requestPhotoAssetUploads") {
      const items = input.assets.map((asset) => ({
        kind: "CREATE_ASSET",
        clientAssetId: asset.clientAssetId,
        photoAssetId: `photo-${asset.clientAssetId}`,
        uploads: [
          { variant: "PROCESSED", uploadUrl: "https://s3.invalid/p", expectedBytes: asset.processed.fileSize, expectedMimeType: "image/jpeg", expectedSha256: asset.processed.sha256 },
          { variant: "THUMBNAIL", uploadUrl: "https://s3.invalid/t", expectedBytes: asset.thumbnail.fileSize, expectedMimeType: "image/jpeg", expectedSha256: asset.thumbnail.sha256 },
        ],
      }));
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { batchId: "b1", revision: 0, items } }) };
    }
    if (op === "completePhotoAssetUpload") return { ok: true, status: 200, json: async () => ({ ok: true, value: { photoAssetId: input.photoAssetId, status: "READY" } }) };
    if (op === "completePhotoBatch") return { ok: true, status: 200, json: async () => ({ ok: true, value: { batchId: "b1", status: "READY_FOR_REVIEW" } }) };
    throw new Error(`unexpected op ${op}`);
  };
}

test("CLIの引数配線を通しても取込済みセッションを編集・アップロードできる", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-photo-cli-"));
  const sourceDir = path.join(dir, "source");
  await writeFile(path.join(dir, "source-marker"), "");
  await import("node:fs/promises").then((fs) => fs.mkdir(sourceDir, { recursive: true }));
  await writeFile(path.join(sourceDir, "IMG_0001.JPG"), await makeSyntheticSourceJpeg({ width: 120, height: 80 }));
  await writeFile(path.join(sourceDir, "IMG_0002.jpg"), await makeSyntheticSourceJpeg({ width: 120, height: 80, color: { r: 5, g: 200, b: 5 } }));
  await writeFile(path.join(sourceDir, "notes.txt"), "not an image");

  const originalFetch = global.fetch;
  const originalToken = process.env.BELLO_PHOTO_STATION_TOKEN;
  global.fetch = stubFetch();
  process.env.BELLO_PHOTO_STATION_TOKEN = "test-token";
  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BELLO_PHOTO_STATION_TOKEN;
    else process.env.BELLO_PHOTO_STATION_TOKEN = originalToken;
  });

  const result = await main([
    "--session-id", "cli-session-1",
    "--source-dir", sourceDir,
    "--output-root", path.join(dir, "out"),
    "--settings-file", path.join(dir, "settings.json"),
    "--history-file", path.join(dir, "history.json"),
    "--device-id", "DEVICE-CLI-TEST",
    "--api-endpoint", "https://api.invalid",
  ]);

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.uploaded.length, 2, "非画像ファイル(notes.txt)は対象から除外される");
});

test("トークンが無ければ明示的に失敗する(秘密情報の既定値を持たない)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-photo-cli-notoken-"));
  const originalToken = process.env.BELLO_PHOTO_STATION_TOKEN;
  delete process.env.BELLO_PHOTO_STATION_TOKEN;
  try {
    await assert.rejects(
      main([
        "--session-id", "s",
        "--source-dir", dir,
        "--output-root", path.join(dir, "out"),
        "--settings-file", path.join(dir, "settings.json"),
        "--history-file", path.join(dir, "history.json"),
        "--device-id", "d",
        "--api-endpoint", "https://api.invalid",
      ]),
      /BELLO_PHOTO_STATION_TOKEN/,
    );
  } finally {
    if (originalToken !== undefined) process.env.BELLO_PHOTO_STATION_TOKEN = originalToken;
  }
});
