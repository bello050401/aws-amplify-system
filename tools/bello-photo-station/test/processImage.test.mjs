import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { processImage, sha256File } from "../src/processImage.mjs";
import { DEFAULT_SETTINGS } from "../src/settings.mjs";
import { makeSyntheticSourceJpeg } from "./testFixtures.mjs";

test("承認済みの商品クロップを本画像とサムネイルに同じ比率で適用する", async () => {
  const dir = await tempDir();
  const sourcePath = path.join(dir, "source.jpg");
  await writeFile(sourcePath, await makeSyntheticSourceJpeg({ width: 1200, height: 800, orientation: 1 }));
  const result = await processImage({ sourcePath, processedPath: path.join(dir, "processed.jpg"),
    thumbnailPath: path.join(dir, "thumb.jpg"), settings: { ...DEFAULT_SETTINGS,
      productCrop: { left: 200, top: 0, width: 800, height: 800 }, longEdgePx: 600, thumbnailLongEdgePx: 120 } });
  assert.deepEqual([result.processed.width, result.processed.height], [600, 600]);
  assert.deepEqual([result.thumbnail.width, result.thumbnail.height], [120, 120]);
});

test("被写体不明の旧設定でも3:2の枠を写真で埋める", async () => {
  const dir = await tempDir();
  const sourcePath = path.join(dir, "source.jpg");
  await sharp({ create: { width: 1200, height: 675, channels: 3, background: '#831e21' } })
    .jpeg().toFile(sourcePath);
  const result = await processImage({ sourcePath, processedPath: path.join(dir, "processed.jpg"),
    thumbnailPath: path.join(dir, "thumb.jpg"), settings: { ...DEFAULT_SETTINGS,
      productContainAspectRatio: 1.5, longEdgePx: 600, thumbnailLongEdgePx: 120 } });
  assert.deepEqual([result.processed.width, result.processed.height], [600, 400]);
  assert.deepEqual([result.thumbnail.width, result.thumbnail.height], [120, 80]);
  const top = await sharp(result.processed.path).extract({ left: 300, top: 2, width: 1, height: 1 }).raw().toBuffer();
  const middle = await sharp(result.processed.path).extract({ left: 300, top: 200, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(top[0] > top[1] * 2 && top[0] < 160, 'top edge stays red, no neutral padding');
  assert.ok(middle[0] > middle[1] * 2, 'the complete red source stays in the center');
});

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
