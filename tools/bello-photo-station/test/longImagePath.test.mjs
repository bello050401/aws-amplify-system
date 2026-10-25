import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { processImage, sha256File } from '../src/processImage.mjs';
import { prepareProductFraming } from '../src/productFraming.mjs';
import { analyzeStudioPhoto, estimateStudioLevel } from '../src/autoFraming.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';

async function fixture() {
  let directory = await mkdtemp(path.join(tmpdir(), 'bello-long-image-'));
  while (directory.length < 330) directory = path.join(directory, '日本語の商品写真_非常に長い保存フォルダー');
  await mkdir(directory, { recursive: true });
  const sourcePath = path.join(directory, '①_編集前の写真.jpg');
  const bytes = await sharp(Buffer.from('<svg width="900" height="600"><rect width="900" height="600" fill="#eee"/><rect x="340" y="160" width="220" height="320" fill="#323232"/></svg>')).jpeg().toBuffer();
  await writeFile(sourcePath, bytes);
  return { directory, sourcePath, bytes };
}

test('260文字超の日本語パスで構図・画像・スタンプ・サムネイルを保存し、再保存しても同じ結果になる', async () => {
  const { directory, sourcePath, bytes } = await fixture();
  const logoPath = path.join(directory, 'ロゴ.png');
  await writeFile(logoPath, await sharp({ create: { width: 100, height: 50, channels: 3, background: '#222' } }).png().toBuffer());
  // Both subject detection and horizon detection used to fail at libvips I/O.
  const [detection, level] = await Promise.all([analyzeStudioPhoto(sourcePath), estimateStudioLevel(sourcePath)]);
  assert.ok(detection.status);
  assert.ok(level.status);
  const options = { sourcePath, processedPath: path.join(directory, '保存後の商品画像.jpg'),
    thumbnailPath: path.join(directory, '一覧用の画像.jpg'), settings: { ...DEFAULT_SETTINGS, longEdgePx: 600, thumbnailLongEdgePx: 120 },
    stamp: { logoPath, geometry: { sourceWidth: 900, sourceHeight: 600, subjectBox: { left: 340, top: 160, width: 220, height: 320 } } } };
  const first = await processImage(options);
  const second = await processImage(options);
  assert.equal(first.processed.sha256, second.processed.sha256);
  assert.equal(first.thumbnail.sha256, second.thumbnail.sha256);
  assert.deepEqual([first.processed.width, first.processed.height], [600, 400]);
  assert.deepEqual([first.thumbnail.width, first.thumbnail.height], [120, 80]);
  const photo = await sharp(await readFile(first.processed.path)).raw().toBuffer();
  const thumb = await sharp(await readFile(first.thumbnail.path)).metadata();
  assert.equal(thumb.width, 120);
  assert.ok(photo[25 * 600 * 3 + 25 * 3] < 100, 'stamp is present in the output');
  assert.deepEqual(await readFile(sourcePath), bytes, 'original is unchanged');
  assert.ok(!first.processed.path.startsWith('\\\\?\\'), 'normal path is retained for UI/manifest');
});

test('長いパスの現像キャッシュを再利用し、水平補正・構図判定まで完了する', async () => {
  const { directory, sourcePath } = await fixture();
  const source = { sourcePath, fileName: path.basename(sourcePath), clientAssetId: 'long-path-test' };
  const sourceHash = await sha256File(sourcePath);
  let renders = 0;
  const options = { sources: [source], topFileName: source.fileName,
    selectedPresets: new Map([[source.fileName, { preset: { id: 'test', hash: 'hash' }, signature: 'signature' }]]),
    outputRoot: path.join(directory, '編集セッション'), stationRoot: directory, settings: DEFAULT_SETTINGS,
    overrides: { [source.fileName]: { sourceHash, angle: 1, subjectBox: { left: 340, top: 160, width: 220, height: 320 } } },
    render: async () => { renders++; return { path: sourcePath, signature: 'signature' }; } };
  const first = await prepareProductFraming(options);
  const second = await prepareProductFraming(options);
  assert.equal(first.status, 'READY');
  assert.equal(second.confirmationHash, first.confirmationHash);
  assert.equal(renders, 1, 'verified long-path render cache is reused');
  const frame = first.frames.get(source.clientAssetId);
  assert.equal(frame.angle, 1);
  assert.ok((await sharp(await readFile(frame.path)).metadata()).width > 0);
});
