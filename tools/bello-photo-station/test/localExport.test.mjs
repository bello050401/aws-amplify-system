import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { main } from '../src/cli.mjs';
import { ProcessingHistoryStore } from '../src/history.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';
import { runEditAndUploadPipeline } from '../src/runPipeline.mjs';
import { exportLocalPhotos, validateExportDirectory } from '../src/localExport.mjs';
import { sha256File } from '../src/processImage.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'bello-dest-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'station'), target = path.join(base, '保存先 空白');
  const sourceDir = path.join(root, 'sessions', 'test-session', 'source');
  await mkdir(sourceDir, { recursive: true }); await mkdir(target);
  const source = path.join(sourceDir, '商品.jpg');
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#ab936b' } }).jpeg().toFile(source);
  return { base, root, target, sourceDir, source, outputRoot: path.dirname(sourceDir) };
}

for (const destination of ['pc', 'shared']) test(`${destination}: CLI saves real JPEGs without auth or network, preserves originals and retries without duplicates`, async t => {
  const f = await fixture(t), sourceHash = await sha256File(f.source);
  const oldToken = process.env.BELLO_PHOTO_STATION_TOKEN, oldFetch = global.fetch;
  delete process.env.BELLO_PHOTO_STATION_TOKEN;
  global.fetch = () => { throw new Error('Local processing must never call network'); };
  t.after(() => { global.fetch = oldFetch; if (oldToken === undefined) delete process.env.BELLO_PHOTO_STATION_TOKEN; else process.env.BELLO_PHOTO_STATION_TOKEN = oldToken; });
  const args = ['--session-id', 'test-session', '--source-dir', f.sourceDir, '--output-root', f.outputRoot,
    '--settings-file', path.join(f.root, 'settings.json'), '--history-file', path.join(f.root, 'history.json'),
    '--destination', destination, '--export-directory', f.target];
  const result = await main(args);
  assert.equal(result.status, 'SAVED_LOCAL'); assert.equal(result.uploaded.length, 0);
  assert.equal((await sharp(path.join(result.savedDirectory, result.saved[0].fileName)).metadata()).format, 'jpeg');
  assert.equal(await sha256File(f.source), sourceHash);
  assert.equal((await main(args)).savedDirectory, result.savedDirectory);
  assert.equal((await readdir(f.target)).length, 1);
  await writeFile(path.join(result.savedDirectory, result.saved[0].fileName), 'user edit');
  const failed = await main(args);
  assert.equal(failed.status, 'FAILED');
  assert.equal(await readFile(path.join(result.savedDirectory, result.saved[0].fileName), 'utf8'), 'user edit');
  assert.equal(await sha256File(f.source), sourceHash);
});

test('disconnected destination and station-internal destination fail without creating folders', async t => {
  const f = await fixture(t);
  await assert.rejects(validateExportDirectory(path.join(f.base, 'missing-share')), { code: 'ENOENT' });
  await assert.rejects(validateExportDirectory(f.sourceDir, [f.root]), /外/);
  await assert.rejects(validateExportDirectory('relative/path'), /選択/);
});

test('a broken image prevents publishing a partial local product', async t => {
  const f = await fixture(t);
  const broken = path.join(f.sourceDir, 'broken.jpg'); await writeFile(broken, 'broken');
  const result = await runEditAndUploadPipeline({ sessionId: 'test-session', sources: [
    { clientAssetId: '001', fileName: '商品.jpg', sourcePath: f.source },
    { clientAssetId: '002', fileName: 'broken.jpg', sourcePath: broken }], settings: DEFAULT_SETTINGS,
    outputRoot: f.outputRoot, stationRoot: f.root, history: new ProcessingHistoryStore(path.join(f.root, 'history.json')),
    destination: 'shared', exportDirectory: f.target });
  assert.equal(result.status, 'FAILED'); assert.equal((await readdir(f.target)).length, 0);
});

test('failed copy keeps existing files and leaves no completed product', async t => {
  const f = await fixture(t); const sentinel = path.join(f.target, 'existing.txt'); await writeFile(sentinel, 'keep');
  await assert.rejects(exportLocalPhotos({ sessionId: 'test-session', directory: f.target, assets: [
    { fileName: 'image.jpg', processedPath: f.source, thumbnailPath: path.join(f.base, 'missing.jpg') }] }));
  assert.deepEqual(await readdir(f.target), ['existing.txt']);
});
