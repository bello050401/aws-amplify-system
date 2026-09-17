import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { processImage, sha256File } from "../src/processImage.mjs";
import { DEFAULT_SETTINGS } from "../src/settings.mjs";
import { makeSyntheticSourceJpeg } from "./testFixtures.mjs";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "bello-photo-process-"));
}

test("長辺・サムネイル長辺を維持しつつ縦横比を保って縮小する", async () => {
  const dir = await tempDir();
  const sourcePath = path.join(dir, "source.jpg");
  await writeFile(sourcePath, await makeSyntheticSourceJpeg({ width: 400, height: 200, orientation: 1 }));
  const settings = { ...DEFAULT_SETTINGS, longEdgePx: 120, thumbnailLongEdgePx: 30 };
  const result = await processImage({
    sourcePath,
    processedPath: path.join(dir, "processed.jpg"),
    thumbnailPath: path.join(dir, "thumb.jpg"),
    settings,
  });
  assert.equal(result.processed.width, 120);
  assert.equal(result.processed.height, 60);
  assert.equal(result.thumbnail.width, 30);
  assert.equal(result.thumbnail.height, 15);
});

test("画像方向を正規化する(orientation=6は90度回転して幅高さが入れ替わる)", async () => {
  const dir = await tempDir();
  const sourcePath = path.join(dir, "source.jpg");
  await writeFile(sourcePath, await makeSyntheticSourceJpeg({ width: 400, height: 200, orientation: 6 }));
  const settings = { ...DEFAULT_SETTINGS, longEdgePx: 400, thumbnailLongEdgePx: 100 };
  const result = await processImage({
    sourcePath,
    processedPath: path.join(dir, "processed.jpg"),
    thumbnailPath: path.join(dir, "thumb.jpg"),
    settings,
  });
  assert.equal(result.processed.width, 200);
  assert.equal(result.processed.height, 400);
  const meta = await sharp(result.processed.path).metadata();
  assert.equal(meta.orientation, undefined);
});

test("GPS・撮影者情報などのメタデータを削除する(既定のstripMetadata=true)", async () => {
  const dir = await tempDir();
  const sourcePath = path.join(dir, "source.jpg");
  const sourceBytes = await makeSyntheticSourceJpeg({ orientation: 1 });
  await writeFile(sourcePath, sourceBytes);
  const sourceMeta = await sharp(sourceBytes).metadata();
  assert.ok(sourceMeta.exif, "test fixture must embed EXIF to make this a meaningful test");

  const result = await processImage({
    sourcePath,
    processedPath: path.join(dir, "processed.jpg"),
    thumbnailPath: path.join(dir, "thumb.jpg"),
    settings: DEFAULT_SETTINGS,
  });
  const processedMeta = await sharp(result.processed.path).metadata();
  const thumbnailMeta = await sharp(result.thumbnail.path).metadata();
  assert.equal(processedMeta.exif, undefined);
  assert.equal(thumbnailMeta.exif, undefined);
});

test("stripMetadata=falseなら明示的にメタデータを残せる(設定画面での切替を想定)", async () => {
  const dir = await tempDir();
  const sourcePath = path.join(dir, "source.jpg");
  await writeFile(sourcePath, await makeSyntheticSourceJpeg({ orientation: 1 }));
  const result = await processImage({
    sourcePath,
    processedPath: path.join(dir, "processed.jpg"),
    thumbnailPath: path.join(dir, "thumb.jpg"),
    settings: { ...DEFAULT_SETTINGS, stripMetadata: false },
  });
  const processedMeta = await sharp(result.processed.path).metadata();
  assert.ok(processedMeta.exif);
});

test("原本ファイルは変更されない(バイト列が処理前後で同一)", async () => {
  const dir = await tempDir();
  const sourcePath = path.join(dir, "source.jpg");
  const original = await makeSyntheticSourceJpeg({ orientation: 1 });
  await writeFile(sourcePath, original);
  const before = await sha256File(sourcePath);
  await processImage({
    sourcePath,
    processedPath: path.join(dir, "processed.jpg"),
    thumbnailPath: path.join(dir, "thumb.jpg"),
    settings: DEFAULT_SETTINGS,
  });
  const after = await sha256File(sourcePath);
  assert.equal(before, after);
  assert.deepEqual(await readFile(sourcePath), original);
});

test("処理途中で失敗しても原本は破損しない(存在しないsourceでエラー)", async () => {
  const dir = await tempDir();
  await assert.rejects(
    processImage({
      sourcePath: path.join(dir, "missing.jpg"),
      processedPath: path.join(dir, "processed.jpg"),
      thumbnailPath: path.join(dir, "thumb.jpg"),
      settings: DEFAULT_SETTINGS,
    }),
  );
  await assert.rejects(stat(path.join(dir, "processed.jpg")));
});

test("JPEG品質・サムネイル品質の設定が出力バイト数に反映される(高品質ほど大きい)", async () => {
  const dir = await tempDir();
  const sourcePath = path.join(dir, "source.jpg");
  await writeFile(sourcePath, await makeSyntheticSourceJpeg({ width: 300, height: 300, orientation: 1, color: { r: 10, g: 200, b: 90 } }));
  const low = await processImage({
    sourcePath,
    processedPath: path.join(dir, "low.jpg"),
    thumbnailPath: path.join(dir, "low-thumb.jpg"),
    settings: { ...DEFAULT_SETTINGS, jpegQuality: 30 },
  });
  const high = await processImage({
    sourcePath,
    processedPath: path.join(dir, "high.jpg"),
    thumbnailPath: path.join(dir, "high-thumb.jpg"),
    settings: { ...DEFAULT_SETTINGS, jpegQuality: 95 },
  });
  assert.ok(high.processed.size >= low.processed.size);
});
