import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chunk, PhotoRegistrationApiClient, uploadSession } from "../src/client.mjs";
import { CheckpointStore } from "../src/checkpointStore.mjs";

test("25件単位に分割し26件は25+1になる", () => assert.deepEqual(chunk(Array.from({ length: 26 }), 25).map((x) => x.length), [25, 1]));

test("認証付きAPI、presigned PUT、完了通知を順番に実行する", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-photo-"));
  const processedPath = path.join(dir, "p.jpg"), thumbnailPath = path.join(dir, "t.jpg");
  await writeFile(processedPath, "processed"); await writeFile(thumbnailPath, "thumb");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "PUT") return { ok: true, status: 200 };
    const op = url.split("/").at(-1);
    const input = JSON.parse(init.body);
    const values = {
      createPhotoBatch: { batchId: "b1", batchCode: "PB-1", status: "CREATED" },
      requestPhotoAssetUploads: { batchId: "b1", revision: 0, items: [{ kind: "CREATE_ASSET", clientAssetId: input.assets?.[0]?.clientAssetId, photoAssetId: "a1", uploads: [
        { variant: "PROCESSED", uploadUrl: "https://s3.invalid/p", expectedBytes: 9, expectedMimeType: "image/jpeg", expectedSha256: input.assets?.[0]?.processed.sha256 },
        { variant: "THUMBNAIL", uploadUrl: "https://s3.invalid/t", expectedBytes: 5, expectedMimeType: "image/jpeg", expectedSha256: input.assets?.[0]?.thumbnail.sha256 },
      ] }] },
      completePhotoAssetUpload: { photoAssetId: "a1", status: "READY" },
      completePhotoBatch: { batchId: "b1", status: "READY_FOR_REVIEW" },
    };
    return { ok: true, status: 200, json: async () => ({ ok: true, value: values[op] }) };
  };
  const api = new PhotoRegistrationApiClient({ endpoint: "https://api.invalid", tokenProvider: async () => "token", fetchImpl });
  const checkpoints = [];
  const result = await uploadSession({ api, deviceId: "DEVICE-1", sessionId: "session-1", assets: [{ fileName: "x.jpg", processedPath, thumbnailPath, processedDimensions: { width: 100, height: 80 }, thumbnailDimensions: { width: 20, height: 16 } }], onCheckpoint: async (c) => checkpoints.push(c.phase) });
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.deepEqual(calls.map((c) => c.init.method), ["POST", "POST", "PUT", "PUT", "POST", "POST"]);
  assert.equal(calls[0].init.headers.authorization, "Bearer token");
  assert.deepEqual(checkpoints, ["BATCH_CREATED", "ASSET_READY", "COMPLETE"]);
});

test("IDEMPOTENCY_CONFLICTは再試行しない", async () => {
  let calls = 0;
  const api = new PhotoRegistrationApiClient({ endpoint: "https://api.invalid", tokenProvider: async () => "token", retries: 3, fetchImpl: async () => { calls += 1; return { ok: false, status: 409, json: async () => ({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", message: "conflict" } }) }; } });
  await assert.rejects(api.call("createPhotoBatch", {}), (error) => error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(calls, 1);
});

test("checkpointは同一sessionを原子的に更新する", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-checkpoint-")); const store = new CheckpointStore(path.join(dir, "state.json"));
  await store.record({ sessionId: "s1", phase: "BATCH_CREATED", batchId: "b1" });
  await store.record({ sessionId: "s1", phase: "COMPLETE" });
  assert.deepEqual(await store.read().then((x) => [x.s1.batchId, x.s1.phase]), ["b1", "COMPLETE"]);
});
