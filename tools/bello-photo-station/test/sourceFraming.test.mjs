import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { recoverSourceFraming } from '../src/sourceFraming.mjs';
import { prepareProductFraming } from '../src/productFraming.mjs';

const sourcePath = fileURLToPath(new URL('./fixtures/neutral-bench.jpg', import.meta.url));
const renderedPath = fileURLToPath(new URL('./fixtures/neutral-bench-lightroom.jpg', import.meta.url));

test('actual Lightroom white bench keeps all legs and saves a square crop without background bands', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-lightroom-bench-'));
  const result = await prepareProductFraming({ sources: [{ sourcePath, fileName: 'bench.jpg', clientAssetId: '001' }],
    topFileName: 'bench.jpg', outputRoot: root, stationRoot: root, settings: { longEdgePx: 768 },
    selectedPresets: new Map([['bench.jpg', { preset: { hash: 'test' }, signature: 'test' }]]),
    render: async () => ({ path: renderedPath, signature: 'test' }) });
  assert.equal(result.status, 'READY');
  assert.equal(result.aspectRatio, 1);
  assert.deepEqual(result.containAssetIds, []);
  const crop = result.crops['001'];
  assert.equal(crop.width, crop.height);
  assert.ok(crop.left <= 245 && crop.left + crop.width >= 494);
  assert.ok(crop.top <= 130 && crop.top + crop.height >= 318);
  assert.ok(result.frames.get('001').subjectBox);
});

test('original outline is not reused for a crop, mirror, rotation or translation even at the same aspect ratio', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-framing-transform-'));
  const metadata = await sharp(renderedPath).metadata();
  const cases = [sharp(renderedPath).flop(),
    sharp(renderedPath).extract({ left: 40, top: 20, width: metadata.width - 80, height: metadata.height - 40 }).resize(metadata.width, metadata.height),
    sharp(renderedPath).rotate(3).resize(metadata.width, metadata.height, { fit: 'fill' }),
    sharp(renderedPath).extend({ left: 25, right: 0, top: 0, bottom: 0, background: '#ddd' }).resize(metadata.width, metadata.height, { fit: 'fill' })];
  for (let i = 0; i < cases.length; i++) {
    const file = path.join(root, `${i}.jpg`); await cases[i].jpeg().toFile(file);
    assert.equal(await recoverSourceFraming(sourcePath, file), null, `unsafe transform ${i}`);
  }
});

test('no subject or unreadable original cannot authorize an automatic crop', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-framing-empty-'));
  const file = path.join(root, 'blank.jpg');
  await sharp({ create: { width: 768, height: 432, channels: 3, background: '#ddd' } }).jpeg().toFile(file);
  assert.equal(await recoverSourceFraming(file, renderedPath), null);
  assert.equal(await recoverSourceFraming(sourcePath, file), null);
  assert.equal(await recoverSourceFraming(path.join(root, 'missing.arw'), renderedPath), null);
});
