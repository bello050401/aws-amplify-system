import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { renderLightroom } from '../src/lightroomRenderer.mjs';

test('test data uses installed renderer only through new job copies and dedicated preset subdirectory', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'bello-bridge-test-'));
  const root = path.join(base, 'test'), service = path.join(base, 'installed');
  const bridge = path.join(service, 'lightroom');
  const originalEnv = process.env.BELLO_LIGHTROOM_BRIDGE_ROOT;
  process.env.BELLO_LIGHTROOM_BRIDGE_ROOT = service;
  t.after(async () => { if (originalEnv === undefined) delete process.env.BELLO_LIGHTROOM_BRIDGE_ROOT; else process.env.BELLO_LIGHTROOM_BRIDGE_ROOT = originalEnv; await rm(base, { recursive: true, force: true }); });
  await mkdir(root); await mkdir(path.join(bridge, 'requests'), { recursive: true });
  const source = path.join(root, 'photo.jpg'), preset = path.join(root, 'preset.xmp');
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#bbbbbb' } }).jpeg().toFile(source);
  await writeFile(preset, 'test preset');
  // Simulate a service becoming ready after Lightroom startup.
  const serviceTask = (async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    await writeFile(path.join(bridge, 'heartbeat.json'), JSON.stringify({ protocol: 2, unixMs: Date.now() }));
    let request;
    const until = Date.now() + 4000;
    while (!request && Date.now() < until) {
      request = (await readdir(path.join(bridge, 'requests'))).find(n => n.endsWith('.ready'));
      if (!request) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(request);
    const fields = (await readFile(path.join(bridge, 'requests', request), 'utf8')).split('\n').map(v => Buffer.from(v, 'hex').toString());
    const job = path.join(bridge, 'jobs', fields[1]);
    assert.equal(path.dirname(fields[2]), job);
    assert.ok(fields[4].startsWith(path.join(service, 'presets', 'desktop-test-jobs')));
    assert.equal(await readFile(fields[4], 'utf8'), 'test preset');
    await copyFile(fields[2], path.join(job, 'render.jpg'));
    await writeFile(path.join(job, 'result.json'), JSON.stringify({ ok: true, signature: 'verified' }));
  })();
  const result = await renderLightroom({ root, sourcePath: source, preset: { id: 'test', file: preset }, timeoutMs: 5000, waitForReadyMs: 5000 });
  await serviceTask;
  assert.equal(result.signature, 'verified');
  assert.equal(await readFile(preset, 'utf8'), 'test preset');
  assert.deepEqual(await readdir(path.join(service, 'presets')), ['desktop-test-jobs']);
});
