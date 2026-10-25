import { mkdir, readFile, writeFile, rename, readdir, copyFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { sha256File, processImage } from './processImage.mjs';
import { settingsHash } from './settings.mjs';
import { renderLightroom, renderCachedLightroom } from './lightroomRenderer.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, file);
}
export function within(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('保存先の範囲外です');
  return path.resolve(file);
}
export function parsePreset(xml, file) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('有効なXMPではありません');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, processEntities: true });
  const doc = parser.parse(xml)['x:xmpmeta']?.['rdf:RDF']?.['rdf:Description'];
  const id = doc?.['crs:UUID']?.replaceAll('-', '').toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(id ?? '') || doc['crs:PresetType'] !== 'Normal') throw new Error('現像プリセットのXMPを選んでください');
  const names = doc['crs:Name']?.['rdf:Alt']?.['rdf:li'];
  const name = (Array.isArray(names) ? names.find(n => n['xml:lang'] === 'x-default') ?? names[0] : names);
  return { id, name: String(name?.['#text'] ?? name ?? path.basename(file, '.xmp')), hash: digest(xml), file };
}
export async function listPresets(root) {
  const dir = path.join(root, 'presets');
  await mkdir(dir, { recursive: true });
  const presets = [], errors = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xmp')) continue;
    const file = path.join(dir, entry.name);
    try {
      const p = parsePreset(await readFile(file, 'utf8'), file);
      if (presets.some(x => x.id === p.id)) throw new Error('同じIDのプリセットが重複しています');
      presets.push(p);
    } catch (e) { errors.push({ fileName: entry.name, message: e.message }); }
  }
  return { presets: presets.sort((a, b) => a.name.localeCompare(b.name)), errors };
}
export async function importPreset(root, source) {
  if ((await stat(source)).size > 16 * 1024 * 1024) throw new Error('プリセットが大きすぎます');
  const xml = await readFile(source, 'utf8');
  const p = parsePreset(xml, source);
  const file = path.join(root, 'presets', `${p.id}.xmp`);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  await writeFile(temp, xml); await rename(temp, file);
  const disabledFile = path.join(root, 'presets', 'disabled.json');
  const disabled = await readJson(disabledFile, []);
  if (disabled.includes(p.id)) await writeJson(disabledFile, disabled.filter(id => id !== p.id));
  return { ...p, file };
}
export async function deletePreset(root, id) {
  if (!/^[A-F0-9]{32}$/.test(id)) throw new Error('プリセットIDが不正です');
  const preset = (await listPresets(root)).presets.find(item => item.id === id);
  if (!preset) throw new Error('プリセットが見つかりません');
  const disabledFile = path.join(root, 'presets', 'disabled.json');
  const disabled = await readJson(disabledFile, []);
  await writeJson(disabledFile, [...new Set([...disabled, id])]);
  await unlink(path.join(root, 'presets', `${id}.xmp`));
  return { deleted: true, name: preset.name };
}
export async function collectSources(sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  return entries.filter(e => e.isFile() && /\.(jpe?g|arw)$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e, index) => ({ clientAssetId: String(index + 1).padStart(3, '0'), fileName: e.name, sourcePath: path.join(sourceDir, e.name) }));
}
export async function generateComparisons({ root, sessionRoot, representative, settings, presetIds = null, render = renderLightroom, onProgress = () => {} }) {
  within(path.join(sessionRoot, 'source'), representative);
  const { presets } = await listPresets(root);
  if (!presets.length) throw new Error('プリセットを追加してください。個数の上限はありません。');
  const comparisonId = randomUUID();
  const directory = path.join(sessionRoot, 'comparisons', comparisonId);
  const manifest = { comparisonId, representative, sourceHash: await sha256File(representative), settingsHash: settingsHash(settings), cards: [] };
  await mkdir(directory, { recursive: true });
  const selectedPresets = presetIds === null ? presets : presets.filter(p => presetIds.includes(p.id));
  if (presetIds !== null && selectedPresets.length !== new Set(presetIds).size) throw new Error('比較するプリセットが見つかりません');
  for (const preset of [null, ...selectedPresets]) {
    onProgress(preset ? `${preset.name} のプレビューを作成中` : '補正前のプレビューを作成中');
    const card = { preset, name: preset?.name ?? '補正前（Lightroom標準現像）', canSelect: !!preset };
    try {
      const rendered = await renderCachedLightroom({ root, sourcePath: representative, preset, longEdgePx: 1600, jpegQuality: 90,
        cacheDir: path.join(sessionRoot, 'comparisons', 'render-cache') }, render);
      card.path = path.join(directory, `${preset?.id ?? 'original'}.jpg`);
      await processImage({ sourcePath: rendered.path, processedPath: card.path,
        thumbnailPath: path.join(directory, `${preset?.id ?? 'original'}-thumb.jpg`),
        settings: { ...settings, lightroomPresetName: null, longEdgePx: 1600, thumbnailLongEdgePx: 320,
          brightness: 0, contrast: 0, colorTemperatureShift: 0, saturation: 0, sharpness: 0 } });
      card.signature = rendered.signature;
    } catch (e) { card.error = e.message; card.canSelect = false; }
    manifest.cards.push(card);
  }
  await writeJson(path.join(directory, 'manifest.json'), manifest);
  return manifest;
}
export async function chooseProductPreset({ root, sessionRoot, presetId, settings }) {
  const preset = (await listPresets(root)).presets.find(p => p.id === presetId);
  if (!preset) throw new Error('商品に使うプリセットを選択してください');
  const sources = await collectSources(path.join(sessionRoot, 'source'));
  if (!sources.length) throw new Error('商品写真がありません');
  // This fast path skips the comparison preview, so there is no real Lightroom
  // render yet to derive a signature from. Fabricating one here (e.g. hashing
  // the preset file) never matches what Lightroom reports for the actual
  // render and makes every final develop fail with a false "preset changed" error.
  const choices = {};
  for (const source of sources) choices[source.fileName] = {
    preset, signature: null, sourceHash: await sha256File(source.sourcePath),
    settingsHash: settingsHash(settings), selectedAt: new Date().toISOString(),
  };
  await writeJson(path.join(sessionRoot, 'selections.json'), { version: 1, choices });
  return { selectedCount: sources.length, presetName: preset.name };
}
export async function choosePreset({ root, sessionRoot, comparisonId, presetId, sourceNames, settings }) {
  if (!/^[a-f0-9-]{36}$/i.test(comparisonId)) throw new Error('比較結果が無効です');
  const comparison = await readJson(path.join(sessionRoot, 'comparisons', comparisonId, 'manifest.json'));
  if (settingsHash(settings) !== comparison.settingsHash || await sha256File(comparison.representative) !== comparison.sourceHash)
    throw new Error('写真または設定が変わりました。プレビューを作り直してください');
  const card = comparison.cards.find(c => c.preset?.id === presetId && c.canSelect && !c.error);
  if (!card || !card.signature) throw new Error('成功したプレビューから選択してください');
  const current = (await listPresets(root)).presets.find(p => p.id === presetId);
  if (!current || current.hash !== card.preset.hash) throw new Error('プリセットが更新されました。再比較してください');
  if (!sourceNames?.length || !sourceNames.includes(path.basename(comparison.representative))) throw new Error('代表写真を含む対象写真を選んでください');
  const sources = await collectSources(path.join(sessionRoot, 'source'));
  const choices = await readJson(path.join(sessionRoot, 'selections.json'), { version: 1, choices: {} });
  const pending = {};
  for (const name of new Set(sourceNames)) {
    const source = sources.find(s => s.fileName === name);
    if (!source) throw new Error('対象写真が見つかりません');
    pending[name] = { preset: current, signature: card.signature, sourceHash: await sha256File(source.sourcePath), settingsHash: comparison.settingsHash, comparisonId, selectedAt: new Date().toISOString() };
  }
  Object.assign(choices.choices, pending);
  await writeJson(path.join(sessionRoot, 'selections.json'), choices);
  return { selectedCount: Object.keys(choices.choices).length, totalCount: sources.length };
}
export async function validateSelections({ root, sessionRoot, sources, settings }) {
  const { choices } = await readJson(path.join(sessionRoot, 'selections.json'), { choices: {} });
  const { presets } = await listPresets(root);
  const selected = new Map();
  for (const source of sources) {
    const choice = choices[source.fileName];
    const preset = presets.find(p => p.id === choice?.preset.id);
    if (!choice || !preset || preset.hash !== choice.preset.hash || choice.sourceHash !== await sha256File(source.sourcePath) || choice.settingsHash !== settingsHash(settings))
      throw new Error(`${source.fileName}：プリセットをプレビューから選択し直してください`);
    selected.set(source.fileName, { ...choice, preset });
  }
  return selected;
}
