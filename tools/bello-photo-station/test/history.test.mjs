import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProcessingHistoryStore } from "../src/history.mjs";

async function storeInTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-photo-history-"));
  return new ProcessingHistoryStore(path.join(dir, "history.json"));
}

test("処理履歴が無ければ未処理として扱う", async () => {
  const store = await storeInTempDir();
  assert.equal(await store.isAlreadyProcessed("s1", "a1", "hash-a", "hash-b"), false);
});

test("同一の原本ハッシュ・設定ハッシュなら処理済みと判定する(再処理を避ける)", async () => {
  const store = await storeInTempDir();
  await store.recordProcessed("s1", "a1", {
    sourceHash: "src-1",
    settingsHash: "set-1",
    processed: { path: "p.jpg", width: 10, height: 10, size: 100, sha256: "p1" },
    thumbnail: { path: "t.jpg", width: 5, height: 5, size: 20, sha256: "t1" },
  });
  assert.equal(await store.isAlreadyProcessed("s1", "a1", "src-1", "set-1"), true);
});

test("原本または設定が変わっていれば再処理対象になる", async () => {
  const store = await storeInTempDir();
  await store.recordProcessed("s1", "a1", {
    sourceHash: "src-1",
    settingsHash: "set-1",
    processed: { path: "p.jpg" },
    thumbnail: { path: "t.jpg" },
  });
  assert.equal(await store.isAlreadyProcessed("s1", "a1", "src-1", "set-2"), false);
  assert.equal(await store.isAlreadyProcessed("s1", "a1", "src-2", "set-1"), false);
});

test("アップロード結果を記録しても処理結果は失われない(部分更新)", async () => {
  const store = await storeInTempDir();
  await store.recordProcessed("s1", "a1", {
    sourceHash: "src-1",
    settingsHash: "set-1",
    processed: { path: "p.jpg", sha256: "p1" },
    thumbnail: { path: "t.jpg", sha256: "t1" },
  });
  await store.recordUploadResult("s1", "a1", "UPLOADED");
  const entry = await store.findEntry("s1", "a1");
  assert.equal(entry.uploadStatus, "UPLOADED");
  assert.equal(entry.sourceHash, "src-1");
  assert.equal(entry.processed.sha256, "p1");
});

test("失敗記録後に成功記録で上書きできる(安全な再実行)", async () => {
  const store = await storeInTempDir();
  await store.recordProcessed("s1", "a1", {
    sourceHash: "src-1",
    settingsHash: "set-1",
    processed: { path: "p.jpg" },
    thumbnail: { path: "t.jpg" },
  });
  await store.recordUploadResult("s1", "a1", "FAILED", { uploadError: "network" });
  let entry = await store.findEntry("s1", "a1");
  assert.equal(entry.uploadStatus, "FAILED");
  await store.recordUploadResult("s1", "a1", "UPLOADED");
  entry = await store.findEntry("s1", "a1");
  assert.equal(entry.uploadStatus, "UPLOADED");
});

test("書き込みは一時ファイル経由のrenameで行われ、正しいJSONとして残る", async () => {
  const store = await storeInTempDir();
  await store.recordProcessed("s1", "a1", { sourceHash: "src-1", settingsHash: "set-1", processed: {}, thumbnail: {} });
  const parsed = JSON.parse(await readFile(store.file, "utf8"));
  assert.ok(parsed.s1.assets.a1);
});
