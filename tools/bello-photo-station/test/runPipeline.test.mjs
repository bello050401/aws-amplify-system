import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PhotoRegistrationApiClient } from "../src/client.mjs";
import { ProcessingHistoryStore } from "../src/history.mjs";
import { DEFAULT_SETTINGS } from "../src/settings.mjs";
import { runEditAndUploadPipeline, STAGE } from "../src/runPipeline.mjs";
import { makeSyntheticSourceJpeg } from "./testFixtures.mjs";

/** client.test.mjsと同じ考え方の偽サーバ。呼び出し順・ヘッダ・完了応答だけを確認する。 */
function makeFakeApi({ failUploadsFor = new Set(), alreadyReadyFor = new Set() } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "PUT") {
      if (typeof url === "string" && [...failUploadsFor].some((id) => url.includes(id))) {
        return { ok: false, status: 500, text: async () => "boom" };
      }
      return { ok: true, status: 200 };
    }
    const op = url.split("/").at(-1);
    const input = JSON.parse(init.body);
    if (op === "createPhotoBatch") {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { batchId: "b1", batchCode: "PB-1", status: "CREATED" } }) };
    }
    if (op === "requestPhotoAssetUploads") {
      const items = input.assets.map((asset) => {
        if (alreadyReadyFor.has(asset.clientAssetId)) {
          return { kind: "ALREADY_READY", clientAssetId: asset.clientAssetId, photoAssetId: `photo-${asset.clientAssetId}` };
        }
        return {
          kind: "CREATE_ASSET",
          clientAssetId: asset.clientAssetId,
          photoAssetId: `photo-${asset.clientAssetId}`,
          uploads: [
            { variant: "PROCESSED", uploadUrl: `https://s3.invalid/${asset.clientAssetId}/p`, expectedBytes: asset.processed.fileSize, expectedMimeType: "image/jpeg", expectedSha256: asset.processed.sha256 },
            { variant: "THUMBNAIL", uploadUrl: `https://s3.invalid/${asset.clientAssetId}/t`, expectedBytes: asset.thumbnail.fileSize, expectedMimeType: "image/jpeg", expectedSha256: asset.thumbnail.sha256 },
          ],
        };
      });
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { batchId: "b1", revision: 0, items } }) };
    }
    if (op === "completePhotoAssetUpload") {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { photoAssetId: input.photoAssetId, status: "READY" } }) };
    }
    if (op === "completePhotoBatch") {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { batchId: "b1", status: "READY_FOR_REVIEW" } }) };
    }
    throw new Error(`unexpected operation ${op}`);
  };
  const api = new PhotoRegistrationApiClient({ endpoint: "https://api.invalid", tokenProvider: async () => "token", fetchImpl, retries: 0 });
  return { api, calls };
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-photo-pipeline-"));
  const sourceDir = path.join(dir, "source");
  await writeFile(path.join(dir, ".keep"), "");
  return { dir, sourceDir, historyFile: path.join(dir, "history.json") };
}

async function writeSyntheticSource(dir, name, color) {
  const sourcePath = path.join(dir, name);
  await writeFile(sourcePath, await makeSyntheticSourceJpeg({ width: 200, height: 100, orientation: 1, color }));
  return sourcePath;
}

test("SDカード取込→設定読込→編集→アップロード→履歴保存の一連が検証用画像で通る", async () => {
  const { dir, historyFile } = await setup();
  const s1 = await writeSyntheticSource(dir, "a.jpg", { r: 10, g: 20, b: 30 });
  const s2 = await writeSyntheticSource(dir, "b.jpg", { r: 200, g: 150, b: 30 });
  const history = new ProcessingHistoryStore(historyFile);
  const { api, calls } = makeFakeApi();
  const statuses = [];

  const result = await runEditAndUploadPipeline({
    sessionId: "session-1",
    sources: [
      { clientAssetId: "asset-1", fileName: "a.jpg", sourcePath: s1 },
      { clientAssetId: "asset-2", fileName: "b.jpg", sourcePath: s2 },
    ],
    settings: { ...DEFAULT_SETTINGS, longEdgePx: 100, thumbnailLongEdgePx: 25 },
    outputRoot: path.join(dir, "session-1"),
    history,
    api,
    deviceId: "DEVICE-TEST",
    onStatus: (s) => statuses.push(s),
  });

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.uploaded.length, 2);
  assert.deepEqual(statuses, [STAGE.EDITING, STAGE.EDITED, STAGE.UPLOADING, STAGE.UPLOADED, STAGE.SAFE_TO_EJECT]);

  const processedBytes = await readFile(path.join(dir, "session-1", "processed", "asset-1.jpg"));
  assert.ok(processedBytes.length > 0);
  const processedMeta = await sharp(processedBytes).metadata();
  assert.equal(processedMeta.exif, undefined);

  const entry1 = await history.findEntry("session-1", "asset-1");
  assert.equal(entry1.uploadStatus, "UPLOADED");
  assert.ok(entry1.sourceHash);
  assert.ok(entry1.settingsHash);

  const putCalls = calls.filter((c) => c.init.method === "PUT");
  assert.equal(putCalls.length, 4);
});

test("一部失敗しても他の画像は完了し、再実行可能な状態になる", async () => {
  const { dir, historyFile } = await setup();
  const s1 = await writeSyntheticSource(dir, "a.jpg", { r: 10, g: 20, b: 30 });
  const history = new ProcessingHistoryStore(historyFile);
  const { api } = makeFakeApi();
  const statuses = [];

  const result = await runEditAndUploadPipeline({
    sessionId: "session-2",
    sources: [
      { clientAssetId: "asset-1", fileName: "a.jpg", sourcePath: s1 },
      { clientAssetId: "asset-missing", fileName: "missing.jpg", sourcePath: path.join(dir, "does-not-exist.jpg") },
    ],
    settings: DEFAULT_SETTINGS,
    outputRoot: path.join(dir, "session-2"),
    history,
    api,
    deviceId: "DEVICE-TEST",
    onStatus: (s) => statuses.push(s),
  });

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.uploaded.length, 1);
  assert.equal(result.editFailures.length, 1);
  assert.equal(result.editFailures[0].clientAssetId, "asset-missing");
  assert.ok(statuses.includes(STAGE.PARTIAL_FAILURE));
  assert.ok(statuses.includes(STAGE.RETRYABLE));
});

test("同じ原本・同じ設定での再実行は再加工せず、二重アップロードにもならない(安全な再実行)", async () => {
  const { dir, historyFile } = await setup();
  const s1 = await writeSyntheticSource(dir, "a.jpg", { r: 10, g: 20, b: 30 });
  const history = new ProcessingHistoryStore(historyFile);
  const outputRoot = path.join(dir, "session-3");
  const sources = [{ clientAssetId: "asset-1", fileName: "a.jpg", sourcePath: s1 }];
  const settings = DEFAULT_SETTINGS;

  const first = await runEditAndUploadPipeline({
    sessionId: "session-3",
    sources,
    settings,
    outputRoot,
    history,
    api: makeFakeApi().api,
    deviceId: "DEVICE-TEST",
  });
  assert.equal(first.status, "COMPLETE");
  const processedFirst = await readFile(path.join(outputRoot, "processed", "asset-1.jpg"));

  // 2回目はサーバ側もこのclientAssetIdを既に完了済みとして返す(ALREADY_READY)。
  const { api: secondApi, calls } = makeFakeApi({ alreadyReadyFor: new Set(["asset-1"]) });
  const second = await runEditAndUploadPipeline({
    sessionId: "session-3",
    sources,
    settings,
    outputRoot,
    history,
    api: secondApi,
    deviceId: "DEVICE-TEST",
  });
  assert.equal(second.status, "COMPLETE");
  const processedSecond = await readFile(path.join(outputRoot, "processed", "asset-1.jpg"));
  assert.deepEqual(processedFirst, processedSecond);
  const putCalls = calls.filter((c) => c.init.method === "PUT");
  assert.equal(putCalls.length, 0, "既に完了済みのためS3への再送PUTは発生しない");
});

test("設定が変わると再加工され、新しい設定ハッシュが履歴に残る", async () => {
  const { dir, historyFile } = await setup();
  const s1 = await writeSyntheticSource(dir, "a.jpg", { r: 10, g: 20, b: 30 });
  const history = new ProcessingHistoryStore(historyFile);
  const outputRoot = path.join(dir, "session-4");
  const sources = [{ clientAssetId: "asset-1", fileName: "a.jpg", sourcePath: s1 }];

  await runEditAndUploadPipeline({
    sessionId: "session-4",
    sources,
    settings: { ...DEFAULT_SETTINGS, longEdgePx: 150 },
    outputRoot,
    history,
    api: makeFakeApi().api,
    deviceId: "DEVICE-TEST",
  });
  const entryAfterFirst = await history.findEntry("session-4", "asset-1");

  await runEditAndUploadPipeline({
    sessionId: "session-4",
    sources,
    settings: { ...DEFAULT_SETTINGS, longEdgePx: 60 },
    outputRoot,
    history,
    api: makeFakeApi().api,
    deviceId: "DEVICE-TEST",
  });
  const entryAfterSecond = await history.findEntry("session-4", "asset-1");
  assert.notEqual(entryAfterFirst.settingsHash, entryAfterSecond.settingsHash);
  const processedMeta = await sharp(path.join(outputRoot, "processed", "asset-1.jpg")).metadata();
  assert.equal(processedMeta.width, 60);
});
