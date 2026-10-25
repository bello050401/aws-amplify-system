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
    if (op === "requestOriginalPhotoUpload") return {ok:true,status:200,json:async()=>({ok:true,value:{status:"READY"}})};
    if (op === "completeOriginalPhotoUpload") return {ok:true,status:200,json:async()=>({ok:true,value:{status:"READY"}})};
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

test('安全な商品比率を承認画面なしで全画像へ適用する', async () => {
  const { dir, historyFile } = await setup();
  const a = await writeSyntheticSource(dir, 'a.jpg', { r: 90, g: 70, b: 50 });
  const b = await writeSyntheticSource(dir, 'b.jpg', { r: 100, g: 80, b: 60 });
  const sources = [{ clientAssetId: 'a', fileName: 'a.jpg', sourcePath: a },
    { clientAssetId: 'b', fileName: 'b.jpg', sourcePath: b }];
  const { api, calls } = makeFakeApi();
  const result = await runEditAndUploadPipeline({ sessionId: 'framed', sources, settings: { ...DEFAULT_SETTINGS, longEdgePx: 100 },
    outputRoot: dir, history: new ProcessingHistoryStore(historyFile), api, deviceId: 'TEST',
    selectedPresets: new Map(sources.map(source => [source.fileName, { preset: { hash: 'p' }, signature: 'p' }])),
    framingTopFileName: 'b.jpg', stampLogoPath: null, prepareFraming: async () => ({ status: 'READY', aspectRatio: 1,
      crops: { a: { left: 50, top: 0, width: 100, height: 100 }, b: { left: 55, top: 5, width: 90, height: 90 } },
      topAssetId: 'b', confirmationHash: 'plan', frames: new Map([['a', { path: a, angle: 0 }], ['b', { path: b, angle: 0 }]]) }) });
  assert.equal(result.status, 'COMPLETE');
  for (const asset of result.uploaded) {
    assert.equal(asset.processedDimensions.width, asset.processedDimensions.height);
    assert.equal(asset.processedDimensions.width, 90);
  }
  const request = calls.find(call => call.url.endsWith('/requestPhotoAssetUploads'));
  assert.equal(JSON.parse(request.init.body).assets[0].clientAssetId, 'b');
});

test('被写体が見えにくい写真も切らずに商品全体を3:2で送る', async () => {
  const { dir, historyFile } = await setup();
  const a = await writeSyntheticSource(dir, 'a.jpg', { r: 90, g: 70, b: 50 });
  const b = await writeSyntheticSource(dir, 'b.jpg', { r: 100, g: 80, b: 60 });
  const sources = [{ clientAssetId: 'a', fileName: 'a.jpg', sourcePath: a },
    { clientAssetId: 'b', fileName: 'b.jpg', sourcePath: b }];
  const { api } = makeFakeApi();
  const result = await runEditAndUploadPipeline({ sessionId: 'contained', sources,
    settings: { ...DEFAULT_SETTINGS, longEdgePx: 90, thumbnailLongEdgePx: 30 },
    outputRoot: dir, history: new ProcessingHistoryStore(historyFile), api, deviceId: 'TEST',
    selectedPresets: new Map(sources.map(s => [s.fileName, { preset: { hash: 'p' }, signature: 'p' }])),
    framingTopFileName: 'a.jpg', stampLogoPath: null, prepareFraming: async () => ({ status: 'READY', aspectRatio: 1.5,
      crops: { a: { left: 20, top: 0, width: 150, height: 100 }, b: null },
      topAssetId: 'a', confirmationHash: 'plan', frames: new Map([['a', { path: a, angle: 0 }], ['b', { path: b, angle: 0 }]]) }) });
  assert.equal(result.status, 'COMPLETE');
  for (const asset of result.uploaded) assert.deepEqual(asset.processedDimensions, { width: 90, height: 60 });
});

test('商品のトップ画像だけにスタンプを加えてアップロードする', async () => {
  const { dir, historyFile } = await setup();
  const a = await writeSyntheticSource(dir, 'a.jpg', { r: 90, g: 70, b: 50 });
  const b = await writeSyntheticSource(dir, 'b.jpg', { r: 100, g: 80, b: 60 });
  const sources = [{ clientAssetId: 'a', fileName: 'a.jpg', sourcePath: a },
    { clientAssetId: 'b', fileName: 'b.jpg', sourcePath: b }];
  const { api } = makeFakeApi();
  const result = await runEditAndUploadPipeline({ sessionId: 'stamped', sources,
    settings: { ...DEFAULT_SETTINGS, longEdgePx: 100, thumbnailLongEdgePx: 30 },
    outputRoot: dir, history: new ProcessingHistoryStore(historyFile), api, deviceId: 'TEST',
    selectedPresets: new Map(sources.map(s => [s.fileName, { preset: { hash: 'p' }, signature: 'p' }])),
    framingTopFileName: 'a.jpg', prepareFraming: async () => ({ status: 'READY', aspectRatio: 1,
      crops: { a: { left: 50, top: 0, width: 100, height: 100 }, b: { left: 50, top: 0, width: 100, height: 100 } },
      topAssetId: 'a', confirmationHash: 'plan', frames: new Map([
        ['a', { path: a, angle: 0, width: 200, height: 100, subjectBox: { left: 110, top: 25, width: 50, height: 60 } }],
        ['b', { path: b, angle: 0, width: 200, height: 100, subjectBox: { left: 110, top: 25, width: 50, height: 60 } }],
      ]) }) });
  assert.equal(result.status, 'COMPLETE');
  const top = await sharp(path.join(dir, 'processed', 'a.jpg')).stats();
  const sibling = await sharp(path.join(dir, 'processed', 'b.jpg')).stats();
  assert.ok(top.channels[0].stdev > sibling.channels[0].stdev + 5, 'only the stamped top image should contain dark logo pixels');
});

test('被写体または水平が不確実なら商品全体のアップロードを止める', async () => {
  const { dir, historyFile } = await setup();
  const source = await writeSyntheticSource(dir, 'a.jpg', { r: 90, g: 70, b: 50 });
  const { api, calls } = makeFakeApi();
  const result = await runEditAndUploadPipeline({ sessionId: 'unframed', sources: [{ clientAssetId: 'a', fileName: 'a.jpg', sourcePath: source }],
    settings: DEFAULT_SETTINGS, outputRoot: dir, history: new ProcessingHistoryStore(historyFile), api, deviceId: 'TEST',
    selectedPresets: new Map([['a.jpg', { preset: { hash: 'p' }, signature: 'p' }]]), framingTopFileName: 'a.jpg',
    prepareFraming: async () => ({ status: 'NEEDS_REVIEW', reason: '水平線が不明' }) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.editFailures[0].stage, 'FRAMING');
  assert.equal(calls.length, 0);
});

test('プレビュー確認後に構図が変わればアップロードしない', async () => {
  const { dir, historyFile } = await setup();
  const source = await writeSyntheticSource(dir, 'a.jpg', { r: 90, g: 70, b: 50 });
  const { api, calls } = makeFakeApi();
  const result = await runEditAndUploadPipeline({ sessionId: 'changed-frame', sources: [{ clientAssetId: 'a', fileName: 'a.jpg', sourcePath: source }],
    settings: DEFAULT_SETTINGS, outputRoot: dir, history: new ProcessingHistoryStore(historyFile), api, deviceId: 'TEST',
    selectedPresets: new Map([['a.jpg', { preset: { hash: 'p' }, signature: 'p' }]]),
    framingTopFileName: 'a.jpg', confirmedFramingHash: 'old', prepareFraming: async () => ({ status: 'READY', confirmationHash: 'new' }) });
  assert.equal(result.status, 'FAILED');
  assert.equal(calls.length, 0);
});

test('選択したLightroom結果をアップロードし、原本を保持、別のプリセットでは再現像する', async () => {
  const { dir, historyFile } = await setup();
  const source = await writeSyntheticSource(dir, 'original.jpg', { r: 20, g: 20, b: 20 });
  const rendered = await writeSyntheticSource(dir, 'rendered.jpg', { r: 180, g: 180, b: 180 });
  const before = await readFile(source);
  const sources = [{ clientAssetId: '001', fileName: 'original.jpg', sourcePath: source }];
  const history = new ProcessingHistoryStore(historyFile);
  let renders = 0;
  const run = signature => runEditAndUploadPipeline({ sessionId: 'selection', sources,
    settings: { ...DEFAULT_SETTINGS, lightroomPresetName: 'Registered', brightness: -100 },
    selectedPresets: new Map([['original.jpg', { preset: { hash: signature }, signature }]]),
    stationRoot: dir, outputRoot: dir, history, api: makeFakeApi().api, deviceId: 'TEST',
    render: async input => { renders++; assert.equal(input.expectedSignature, signature); return { path: rendered, signature }; } });
  assert.equal((await run('first')).status, 'COMPLETE');
  const stats = await sharp(path.join(dir, 'processed', '001.jpg')).stats();
  assert.ok(stats.channels[0].mean > 150, 'Lightroom output, not dark original/basic tone, must be used');
  await run('first'); assert.equal(renders, 1);
  await run('second'); assert.equal(renders, 2);
  assert.deepEqual(await readFile(source), before);
});

test('プリセット一括適用（比較なし）は本物のLightroom署名と食い違って失敗しない', async () => {
  const { dir, historyFile } = await setup();
  const source = await writeSyntheticSource(dir, 'original.jpg', { r: 20, g: 20, b: 20 });
  const rendered = await writeSyntheticSource(dir, 'rendered.jpg', { r: 180, g: 180, b: 180 });
  const sources = [{ clientAssetId: '001', fileName: 'original.jpg', sourcePath: source }];
  const history = new ProcessingHistoryStore(historyFile);
  const result = await runEditAndUploadPipeline({ sessionId: 'bulk-apply', sources,
    settings: { ...DEFAULT_SETTINGS, lightroomPresetName: 'Registered' },
    // chooseProductPreset does not run a real Lightroom preview, so it must not
    // invent a signature; this mirrors that by leaving signature null.
    selectedPresets: new Map([['original.jpg', { preset: { hash: 'p' }, signature: null }]]),
    stationRoot: dir, outputRoot: dir, history, api: makeFakeApi().api, deviceId: 'TEST',
    render: async input => {
      assert.equal(input.expectedSignature, null);
      return { path: rendered, signature: 'lightroom-computed-signature-xyz' };
    } });
  assert.equal(result.status, 'COMPLETE');
});

test('Lightroom失敗と未選択はアップロードへ進まない', async () => {
  const { dir, historyFile } = await setup();
  const source = await writeSyntheticSource(dir, 'a.jpg', { r: 20, g: 20, b: 20 });
  const { api, calls } = makeFakeApi();
  const input = { sessionId: 'failure', sources: [{ clientAssetId: '001', fileName: 'a.jpg', sourcePath: source }], settings: DEFAULT_SETTINGS,
    outputRoot: dir, history: new ProcessingHistoryStore(historyFile), api, deviceId: 'TEST' };
  await assert.rejects(runEditAndUploadPipeline({ ...input, selectedPresets: new Map() }), /未選択/);
  const result = await runEditAndUploadPipeline({ ...input,
    selectedPresets: new Map([['a.jpg', { preset: { hash: 'p' }, signature: 'p' }]]),
    render: async () => { throw new Error('Lightroom not connected'); } });
  assert.equal(result.status, 'FAILED'); assert.equal(calls.length, 0);
});

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
