import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { renderCachedLightroom } from '../src/lightroomRenderer.mjs';

test('同じ原本とXMPの現像を再利用し、変更・破損時は再現像する', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-lightroom-cache-'));
  try {
    const sourcePath = path.join(root, 'source.jpg');
    const output = path.join(root, 'render.jpg');
    await sharp({ create: { width: 120, height: 80, channels: 3, background: 'red' } }).jpeg().toFile(sourcePath);
    let runs = 0;
    const render = async () => { runs++; await sharp(sourcePath).jpeg().toFile(output); return { path: output, signature: 'signed' }; };
    const options = { sourcePath, preset: { id: 'preset', hash: 'a' }, expectedSignature: 'signed',
      longEdgePx: 120, jpegQuality: 90, cacheDir: path.join(root, 'cache') };
    const first = await renderCachedLightroom(options, render);
    const again = await renderCachedLightroom(options, render);
    assert.equal(first.cacheHit, false);
    assert.equal(again.cacheHit, true);
    assert.equal(runs, 1);
    await renderCachedLightroom({ ...options, preset: { id: 'preset', hash: 'b' } }, render);
    assert.equal(runs, 2, 'XMPの内容変更を再利用しない');
    const replacement = path.join(root, 'replacement.jpg');
    await sharp({ create: { width: 120, height: 80, channels: 3, background: 'blue' } }).jpeg().toFile(replacement);
    await rename(replacement, sourcePath);
    const changed = await renderCachedLightroom(options, render);
    assert.equal(changed.cacheHit, false);
    assert.equal(runs, 3, '元画像の内容変更を再利用しない');
    await writeFile(changed.path, 'broken cache');
    await renderCachedLightroom(options, render);
    assert.equal(runs, 4, 'キャッシュ破損時は再現像する');
    assert.notEqual((await readFile(changed.path)).toString(), 'broken cache');
  } finally { await rm(root, { recursive: true, force: true }); }
});
