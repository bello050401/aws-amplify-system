import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, isUsableValidationToken } from "../src/cli.mjs";
import { makeSyntheticSourceJpeg } from "./testFixtures.mjs";

test('専用端末トークンの期限・認証元・権限を現像前に確認する', () => {
  const nowMs = Date.parse('2026-09-23T00:00:00Z');
  const make = (overrides = {}) => 'header.' + Buffer.from(JSON.stringify({
    iss: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_bKfdql8QT',
    'cognito:groups': ['PHOTO_DEVICE'], exp: nowMs / 1000 + 3600, ...overrides,
  })).toString('base64url') + '.signature';
  assert.equal(isUsableValidationToken(make(), nowMs), true);
  assert.equal(isUsableValidationToken(make({ exp: nowMs / 1000 + 60 }), nowMs), false);
  assert.equal(isUsableValidationToken(make({ iss: 'https://other.invalid' }), nowMs), false);
  assert.equal(isUsableValidationToken(make({ 'cognito:groups': ['ADMIN'] }), nowMs), false);
  assert.equal(isUsableValidationToken('invalid', nowMs), false);
});

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
    if (op === "requestOriginalPhotoUpload") return {ok:true,status:200,json:async()=>({ok:true,value:{status:"READY"}})};
    if (op === "completeOriginalPhotoUpload") return {ok:true,status:200,json:async()=>({ok:true,value:{status:"READY"}})};
    if (op === "completePhotoBatch") return { ok: true, status: 200, json: async () => ({ ok: true, value: { batchId: "b1", status: "READY_FOR_REVIEW" } }) };
    throw new Error(`unexpected op ${op}`);
  };
}

test("CLIの引数配線を通しても取込済みセッションを編集・アップロードできる", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-photo-cli-"));
  const sessionId = "e573d2a6-92a8-4a91-a337-af09222374e2";
  const sessionRoot = path.join(dir, "sessions", sessionId);
  const sourceDir = path.join(sessionRoot, "source");
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
    "--session-id", sessionId,
    "--source-dir", sourceDir,
    "--output-root", sessionRoot,
    "--settings-file", path.join(dir, "settings.json"),
    "--history-file", path.join(dir, "history.json"),
    "--device-id", "DEVICE-CLI-TEST",
    "--api-endpoint", "https://api.invalid",
  ]);

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.uploaded.length, 2, "非画像ファイル(notes.txt)は対象から除外される");
  const retention = JSON.parse(await readFile(path.join(sessionRoot, "retention.json"), "utf8"));
  assert.equal(retention.version, 1);
  assert.match(retention.fingerprint, /^[0-9a-f]{64}$/);
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

test("デスクトップ経路はトップ画像なしにアップロードしない", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-photo-unframed-"));
  const sourceDir = path.join(dir, "sessions", "11111111-1111-4111-8111-111111111111", "source");
  await import("node:fs/promises").then((fs) => fs.mkdir(sourceDir, { recursive: true }));
  await writeFile(path.join(sourceDir, "image.jpg"), await makeSyntheticSourceJpeg({ width: 120, height: 80 }));
  const previousToken = process.env.BELLO_PHOTO_STATION_TOKEN;
  process.env.BELLO_PHOTO_STATION_TOKEN = "test-token";
  t.after(() => {
    if (previousToken === undefined) delete process.env.BELLO_PHOTO_STATION_TOKEN;
    else process.env.BELLO_PHOTO_STATION_TOKEN = previousToken;
  });
  await assert.rejects(main([
    "--session-id", "11111111-1111-4111-8111-111111111111",
    "--source-dir", sourceDir, "--output-root", path.dirname(sourceDir),
    "--settings-file", path.join(dir, "settings.json"),
    "--history-file", path.join(dir, "history.json"),
    "--device-id", "TEST", "--api-endpoint", "https://api.invalid",
    "--require-selection", "true",
  ]), /トップ画像を選んで/);
  await writeFile(path.join(path.dirname(sourceDir), 'framing-choice.json'), JSON.stringify({ topFileName: 'image.jpg', confirmedPlanHash: 'a'.repeat(64) }));
  await assert.rejects(main([
    "--session-id", "11111111-1111-4111-8111-111111111111",
    "--source-dir", sourceDir, "--output-root", path.dirname(sourceDir),
    "--settings-file", path.join(dir, "settings.json"),
    "--history-file", path.join(dir, "history.json"),
    "--device-id", "TEST", "--api-endpoint", "https://production.example.com",
    "--require-selection", "true",
  ]), /検証専用API以外/);
});
