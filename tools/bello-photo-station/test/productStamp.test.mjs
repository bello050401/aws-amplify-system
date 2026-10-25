import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chooseStampPlacement, stampProductTop } from '../src/productStamp.mjs';

test('左上を優先し、商品に触れる場合は空いた上隅へ移す', () => {
  const base = { width: 640, height: 640, sourceWidth: 640, sourceHeight: 640, logoRatio: 2 };
  assert.deepEqual(chooseStampPlacement({ ...base, subjectBox: { left: 220, top: 170, width: 200, height: 300 } }),
    { left: 19, top: 26, width: 186, height: 93 });
  const shifted = chooseStampPlacement({ ...base, subjectBox: { left: 30, top: 20, width: 220, height: 300 } });
  assert.equal(shifted.top, 26);
  assert.ok(shifted.left > 300);
  assert.equal(chooseStampPlacement({ ...base, subjectBox: { left: 0, top: 0, width: 640, height: 640 } }), null);
});

test('トップ写真だけに小さなスタンプを焼き込み、元画像を保持する', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bello-stamp-'));
  const original = path.join(dir, 'original.jpg');
  const processedPath = path.join(dir, 'processed.jpg');
  const thumbnailPath = path.join(dir, 'thumb.jpg');
  const logoPath = path.join(dir, 'logo.png');
  await sharp({ create: { width: 640, height: 640, channels: 3, background: '#eeeeee' } }).jpeg().toFile(original);
  await writeFile(processedPath, await readFile(original));
  await sharp(original).resize(160).jpeg().toFile(thumbnailPath);
  await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } })
    .composite([{ input: Buffer.from('<svg width="200" height="100"><text x="30" y="70" font-size="54">B</text></svg>') }])
    .png().toFile(logoPath);
  const before = await readFile(original);
  const placement = await stampProductTop({ processedPath, thumbnailPath, logoPath,
    geometry: { sourceWidth: 640, sourceHeight: 640,
      subjectBox: { left: 220, top: 170, width: 200, height: 300 }, crop: null },
    jpegQuality: 90, thumbnailJpegQuality: 80, thumbnailLongEdgePx: 160 });
  assert.equal(placement.left, 19);
  assert.notDeepEqual(await readFile(processedPath), before);
  assert.deepEqual(await readFile(original), before);
  assert.deepEqual([ (await sharp(processedPath).metadata()).width, (await sharp(thumbnailPath).metadata()).width ], [640, 160]);
});
