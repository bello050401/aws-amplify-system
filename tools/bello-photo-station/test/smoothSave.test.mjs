import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { prepareProductFraming } from '../src/productFraming.mjs';
import { runEditAndUploadPipeline } from '../src/runPipeline.mjs';
import { ProcessingHistoryStore } from '../src/history.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';
import { sha256File } from '../src/processImage.mjs';
import { stampProductTop } from '../src/productStamp.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'bello-smooth-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'station'), out = path.join(base, 'saved');
  await mkdir(root); await mkdir(out);
  const sources = [];
  for (const [id, width, height] of [['top', 600, 400], ['side', 400, 600]]) {
    const sourcePath = path.join(root, `${id}.jpg`);
    await sharp({ create: { width, height, channels: 3, background: '#2468bf' } }).jpeg().toFile(sourcePath);
    sources.push({ clientAssetId: id, fileName: `${id}.jpg`, sourcePath });
  }
  const common = { sources, topFileName: 'top.jpg', stationRoot: root, outputRoot: path.join(root, 'session'),
    selectedPresets: new Map(sources.map(s => [s.fileName, { preset: { hash: 'p' }, signature: 'p' }])),
    settings: { ...DEFAULT_SETTINGS, longEdgePx: 600, thumbnailLongEdgePx: 120 },
    render: async ({ sourcePath }) => ({ path: sourcePath, signature: 'p' }),
    level: async () => ({ status: 'NEEDS_REVIEW' }), detect: async () => ({ status: 'NEEDS_REVIEW' }) };
  return { base, root, out, common };
}

test('unknown photos save edge-to-edge with uniform crops, originals and repeatable cache', async t => {
  const { root, out, common } = await fixture(t);
  const before = await Promise.all(common.sources.map(s => sha256File(s.sourcePath)));
  const plan = await prepareProductFraming(common);
  assert.equal(plan.status, 'READY');
  for (const crop of Object.values(plan.crops)) assert.equal(crop.width, crop.height);
  assert.equal(plan.frames.get('top').width, 600);
  const history = new ProcessingHistoryStore(path.join(root, 'history.json'));
  const args = { ...common, sessionId: 'test', framingTopFileName: 'top.jpg', history,
    prepareFraming: options => prepareProductFraming({ ...options, level: common.level, detect: common.detect }),
    destination: 'pc', exportDirectory: out, api: { createBatch: () => { throw new Error('No network'); } } };
  const result = await runEditAndUploadPipeline(args);
  assert.equal(result.status, 'SAVED_LOCAL', JSON.stringify(result));
  for (const id of ['top', 'side']) {
    const entry = await history.findEntry('test', id);
    const m = await sharp(entry.processed.path).metadata(), thumb = await sharp(entry.thumbnail.path).metadata();
    assert.deepEqual([m.width, m.height], [400, 400]);
    assert.deepEqual([thumb.width, thumb.height], [entry.thumbnail.width, entry.thumbnail.height]);
    assert.equal(await sha256File(entry.processed.path), entry.processed.sha256);
    assert.equal(await sha256File(entry.thumbnail.path), entry.thumbnail.sha256);
  }
  const topHash = (await history.findEntry('test', 'top')).processed.sha256;
  assert.equal((await runEditAndUploadPipeline(args)).savedDirectory, result.savedDirectory);
  assert.equal((await history.findEntry('test', 'top')).processed.sha256, topHash);
  assert.equal((await readdir(out)).length, 1);
  assert.deepEqual(await Promise.all(common.sources.map(s => sha256File(s.sourcePath))), before);
  const previousSettingsHash = (await history.findEntry('test', 'top')).settingsHash;
  // Detection may improve while the source and crop remain identical. Do not
  // reuse the older stamp layout in that case.
  const changed = await runEditAndUploadPipeline({ ...args,
    prepareFraming: async options => {
      const next = await args.prepareFraming(options);
      next.frames.get('top').subjectBox = { left: 250, top: 100, width: 100, height: 200 };
      return next;
    } });
  assert.equal(changed.status, 'SAVED_LOCAL', JSON.stringify(changed));
  assert.notEqual((await history.findEntry('test', 'top')).settingsHash, previousSettingsHash);
  assert.notEqual((await history.findEntry('test', 'top')).processed.sha256, topHash);
});

test('invalid and stale manual framing stays blocked even with automatic full-photo fallback', async t => {
  const { common } = await fixture(t);
  for (const override of [
    { sourceHash: 'stale', angle: 0, subjectBox: { left: 10, top: 10, width: 30, height: 30 } },
    { sourceHash: await sha256File(common.sources[0].sourcePath), angle: 0, subjectBox: { left: -5, top: 0, width: 30, height: 30 } },
    { sourceHash: await sha256File(common.sources[0].sourcePath), angle: 99, subjectBox: { left: 10, top: 10, width: 30, height: 30 } },
  ]) assert.equal((await prepareProductFraming({ ...common, overrides: { 'top.jpg': override } })).status, 'NEEDS_REVIEW');
});

for (const subjectBox of [null, { left: 0, top: 0, width: 600, height: 400 }])
test(`stamp without a safe corner never shifts or shrinks the photo (${subjectBox ? 'full subject' : 'unknown subject'})`, async t => {
  const { root, common } = await fixture(t);
  const processedPath = common.sources[0].sourcePath;
  const logoPath = path.join(root, 'logo.png');
  await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ff0000' } }).png().toFile(logoPath);
  const before = await sha256File(processedPath);
  const p = await stampProductTop({ processedPath, thumbnailPath: path.join(root, 'thumb.jpg'), logoPath,
    geometry: { sourceWidth: 600, sourceHeight: 400, subjectBox }, jpegQuality: 100, thumbnailJpegQuality: 90, thumbnailLongEdgePx: 120 });
  assert.equal(p.skipped, true);
  assert.equal(await sha256File(processedPath), before);
  const { data, info } = await sharp(processedPath).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [600, 400]);
  const pixel = (x, y) => Array.from(data.subarray((y * 600 + x) * 3, (y * 600 + x) * 3 + 3));
  assert.ok(pixel(300, 250)[2] > pixel(300, 250)[0] + 60);
});
