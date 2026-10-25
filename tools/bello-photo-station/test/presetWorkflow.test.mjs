import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
sharp.cache(false);
import { DEFAULT_SETTINGS } from '../src/settings.mjs';
import { collectSources, importPreset, deletePreset, listPresets, generateComparisons, choosePreset, chooseProductPreset, validateSelections, readJson, parsePreset } from '../src/presetWorkflow.mjs';
import { main as presetCli } from '../src/presetCli.mjs';
import { renderLightroom } from '../src/lightroomRenderer.mjs';
import { processImage } from '../src/processImage.mjs';
const xml = (id, name = '白 &amp; 光') => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:UUID="${id}" crs:PresetType="Normal"><crs:Name><rdf:Alt><rdf:li xml:lang="x-default">${name}</rdf:li></rdf:Alt></crs:Name></rdf:Description></rdf:RDF></x:xmpmeta>`;
async function setup(count = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bello-presets-'));
  const sessionRoot = path.join(root, 'sessions', '11111111-1111-1111-1111-111111111111');
  await mkdir(path.join(sessionRoot, 'source'), { recursive: true });
  for (const name of ['one.jpg', 'two.jpg']) await sharp({ create: { width: 64, height: 40, channels: 3, background: '#cccccc' } }).jpeg().toFile(path.join(sessionRoot, 'source', name));
  for (let i = 1; i <= count; i++) {
    const file = path.join(root, `${i}.xmp`);
    await writeFile(file, xml(i.toString(16).padStart(32, '0').toUpperCase()));
    await importPreset(root, file);
  }
  const sources = await collectSources(path.join(sessionRoot, 'source'));
  const render = async ({ preset, sourcePath }) => ({ path: sourcePath, signature: preset?.hash ?? 'original' });
  return { root, sessionRoot, sources, representative: sources[0].sourcePath, settings: DEFAULT_SETTINGS, render };
}
test('catalog is unbounded, uses UUID rather than duplicate display names, rejects corrupt XML', async () => {
  const ctx = await setup(9);
  const catalog = await listPresets(ctx.root);
  assert.equal(catalog.presets.length, 9);
  assert.equal(catalog.presets[0].name, '白 & 光');
  await writeFile(path.join(ctx.root, 'presets', 'broken.xmp'), '<x/>');
  assert.equal((await listPresets(ctx.root)).errors.length, 1);
  assert.throws(() => parsePreset('<!DOCTYPE x SYSTEM "file:///secret"><x/>', 'bad'));
});
test('deleted bundled preset stays removed until explicitly imported again', async () => {
  const ctx = await setup(0);
  const catalog = await presetCli(['presets', ctx.root]);
  const bundled = catalog.presets[0];
  assert.ok(bundled);
  await deletePreset(ctx.root, bundled.id);
  assert.equal((await presetCli(['presets', ctx.root])).presets.some(p => p.id === bundled.id), false);
  const replacement = path.join(ctx.root, 'restore.xmp');
  await writeFile(replacement, xml(bundled.id));
  await importPreset(ctx.root, replacement);
  assert.equal((await listPresets(ctx.root)).presets.some(p => p.id === bundled.id), true);
});
test('one preset applies to every photo without generating a comparison; optional pair renders only the requested preset', async () => {
  const ctx = await setup(3);
  const presets = (await listPresets(ctx.root)).presets;
  const applied = await chooseProductPreset({ ...ctx, presetId: presets[0].id });
  assert.equal(applied.selectedCount, 2);
  const choices = await validateSelections(ctx);
  assert.equal(new Set([...choices.values()].map(choice => choice.preset.id)).size, 1);
  const pair = await generateComparisons({ ...ctx, presetIds: [presets[1].id] });
  assert.equal(pair.cards.length, 2);
  assert.equal(pair.cards[0].name, '補正前（Lightroom標準現像）');
  assert.equal(pair.cards[1].preset.id, presets[1].id);
});
test('CLI persists the default preset and assigns it to an entire session', async () => {
  const ctx = await setup(1);
  const preset = (await listPresets(ctx.root)).presets[0];
  const sessionId = path.basename(ctx.sessionRoot);
  await presetCli(['set-default', ctx.root, sessionId, preset.id]);
  assert.equal((await presetCli(['list', ctx.root, sessionId])).defaultPresetId, preset.id);
  const assigned = await presetCli(['choose-product', ctx.root, sessionId, preset.id]);
  assert.equal(assigned.selectedCount, ctx.sources.length);
  assert.equal((await validateSelections(ctx)).size, ctx.sources.length);
});
test('representative comparisons, per-group choices, restart, and changed presets invalidate choice', async () => {
  const ctx = await setup();
  const preview = await generateComparisons(ctx);
  assert.equal(preview.cards.length, 3);
  assert.equal(preview.cards[0].canSelect, false);
  const args = { ...ctx, comparisonId: preview.comparisonId, presetId: preview.cards[1].preset.id, sourceNames: ['one.jpg'] };
  await choosePreset(args);
  await assert.rejects(validateSelections(ctx), /選択し直/);
  await choosePreset({ ...args, sourceNames: ['one.jpg', 'two.jpg'] });
  assert.equal((await validateSelections(ctx)).size, 2);
  const persisted = await readJson(path.join(ctx.sessionRoot, 'selections.json'));
  assert.equal(persisted.choices['two.jpg'].signature, preview.cards[1].signature);
  await writeFile(preview.cards[1].preset.file, xml(preview.cards[1].preset.id, 'Updated'));
  await assert.rejects(validateSelections(ctx), /選択し直/);
  await assert.rejects(choosePreset(args), /更新/);
});
test('changed source/settings and a failed preview cannot be selected', async () => {
  const ctx = await setup();
  const preview = await generateComparisons({ ...ctx, render: async () => { throw new Error('AI mask update failed'); } });
  assert.ok(preview.cards.every(c => !c.canSelect && c.error));
  await assert.rejects(choosePreset({ ...ctx, comparisonId: preview.comparisonId, presetId: preview.cards[1].preset.id, sourceNames: ['one.jpg'] }), /成功した/);
  const valid = await generateComparisons(ctx);
  const args = { ...ctx, comparisonId: valid.comparisonId, presetId: valid.cards[1].preset.id, sourceNames: ['one.jpg'] };
  await assert.rejects(choosePreset({ ...args, settings: { ...DEFAULT_SETTINGS, jpegQuality: 70 } }), /設定が変わり/);
  await writeFile(ctx.representative, 'changed');
  await assert.rejects(choosePreset(args), /写真または設定/);
});
test('RAW participates in selection; paths outside session are rejected', async () => {
  const ctx = await setup();
  await writeFile(path.join(ctx.sessionRoot, 'source', 'raw.arw'), 'raw');
  assert.equal((await collectSources(path.join(ctx.sessionRoot, 'source'))).length, 3);
  await assert.rejects(generateComparisons({ ...ctx, representative: path.join(ctx.root, 'other.jpg') }), /範囲外/);
});
test('missing Lightroom fails closed, never silently substitutes basic tone', async () => {
  const ctx = await setup();
  await assert.rejects(renderLightroom({ root: ctx.root, sourcePath: ctx.representative }), /連携が停止/);
  await assert.rejects(processImage({ sourcePath: ctx.representative, settings: { ...DEFAULT_SETTINGS, lightroomPresetName: 'White' } }), /簡易処理では適用できません/);
});
test('data-only queue accepts real JPEG response and enforces preset signature', async () => {
  const ctx = await setup();
  await mkdir(path.join(ctx.root, 'lightroom'), { recursive: true });
  await writeFile(path.join(ctx.root, 'lightroom', 'heartbeat.json'), JSON.stringify({ protocol: 2, unixMs: Date.now() }));
  const pending = renderLightroom({ root: ctx.root, sourcePath: ctx.representative, timeoutMs: 5000, expectedSignature: 'expected' });
  let files = [];
  for (let i = 0; i < 100 && !files.length; i++) {
    files = await readdir(path.join(ctx.root, 'lightroom', 'requests')).catch(() => []);
    files = files.filter(f => f.endsWith('.ready'));
    if (!files.length) await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(files.length, 1);
  const fields = (await readFile(path.join(ctx.root, 'lightroom', 'requests', files[0]), 'utf8')).split('\n').map(s => Buffer.from(s, 'hex').toString());
  assert.equal(fields[0], 'BELLO2');
  assert.equal(fields[8], 'expected');
  const dir = path.join(ctx.root, 'lightroom', 'jobs', fields[1]);
  await writeFile(path.join(dir, 'render.jpg'), await readFile(ctx.representative));
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ ok: true, signature: 'expected' }));
  assert.equal((await pending).signature, 'expected');
});
test('Lightroom job receives the real source file name instead of a generic input.jpg', async () => {
  const ctx = await setup();
  await mkdir(path.join(ctx.root, 'lightroom'), { recursive: true });
  await writeFile(path.join(ctx.root, 'lightroom', 'heartbeat.json'), JSON.stringify({ protocol: 2, unixMs: Date.now() }));
  const pending = renderLightroom({ root: ctx.root, sourcePath: ctx.representative, timeoutMs: 5000 });
  let files = [];
  for (let i = 0; i < 100 && !files.length; i++) {
    files = await readdir(path.join(ctx.root, 'lightroom', 'requests')).catch(() => []);
    files = files.filter(f => f.endsWith('.ready'));
    if (!files.length) await new Promise(r => setTimeout(r, 10));
  }
  const fields = (await readFile(path.join(ctx.root, 'lightroom', 'requests', files[0]), 'utf8')).split('\n').map(s => Buffer.from(s, 'hex').toString());
  assert.equal(path.basename(fields[2]), path.basename(ctx.representative));
  assert.notEqual(path.basename(fields[2]), 'input.jpg');
  const dir = path.join(ctx.root, 'lightroom', 'jobs', fields[1]);
  await writeFile(path.join(dir, 'render.jpg'), await readFile(ctx.representative));
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ ok: true, signature: 'anything' }));
  await pending;
});
test('bulk single-preset selection does not fabricate a signature that fights the real Lightroom render', async () => {
  const ctx = await setup();
  const preset = (await listPresets(ctx.root)).presets[0];
  const applied = await chooseProductPreset({ ...ctx, presetId: preset.id });
  assert.equal(applied.selectedCount, ctx.sources.length);
  const selected = await validateSelections(ctx);
  const choice = selected.get(ctx.sources[0].fileName);
  assert.equal(choice.signature, null);

  await mkdir(path.join(ctx.root, 'lightroom'), { recursive: true });
  await writeFile(path.join(ctx.root, 'lightroom', 'heartbeat.json'), JSON.stringify({ protocol: 2, unixMs: Date.now() }));
  const pending = renderLightroom({ root: ctx.root, sourcePath: ctx.sources[0].sourcePath, preset: choice.preset,
    expectedSignature: choice.signature, timeoutMs: 5000 });
  let files = [];
  for (let i = 0; i < 100 && !files.length; i++) {
    files = await readdir(path.join(ctx.root, 'lightroom', 'requests')).catch(() => []);
    files = files.filter(f => f.endsWith('.ready'));
    if (!files.length) await new Promise(r => setTimeout(r, 10));
  }
  const fields = (await readFile(path.join(ctx.root, 'lightroom', 'requests', files[0]), 'utf8')).split('\n').map(s => Buffer.from(s, 'hex').toString());
  const dir = path.join(ctx.root, 'lightroom', 'jobs', fields[1]);
  await writeFile(path.join(dir, 'render.jpg'), await readFile(ctx.sources[0].sourcePath));
  // Lightroom's real reported signature is unrelated to any file hash computed on the Node side.
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ ok: true, signature: 'lightroom-computed-signature-xyz' }));
  const result = await pending;
  assert.equal(result.signature, 'lightroom-computed-signature-xyz');
});
