import { imagePath } from './imagePath.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './isMainModule.mjs';
import { listPresets, importPreset, deletePreset, parsePreset, collectSources, readJson, writeJson, generateComparisons, choosePreset, chooseProductPreset, validateSelections, within } from './presetWorkflow.mjs';
import { SettingsStore } from './settings.mjs';
import { prepareProductFraming } from './productFraming.mjs';
import { processImage, sha256File } from './processImage.mjs';
import { renderLightroom, renderCachedLightroom } from './lightroomRenderer.mjs';
import { analyzeStudioPhoto, estimateStudioLevel } from './autoFraming.mjs';
import sharp from 'sharp';
import { makeTouchPreview } from './touchFraming.mjs';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';

async function seedBundledPresets(root) {
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');
  let entries;
  try { entries = await readdir(bundled); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const disabled = await readJson(path.join(root, 'presets', 'disabled.json'), []);
  for (const name of entries.filter(name => name.toLowerCase().endsWith('.xmp'))) {
    const source = path.join(bundled, name);
    const preset = parsePreset(await readFile(source, 'utf8'), source);
    if (disabled.includes(preset.id)) continue;
    const target = path.join(root, 'presets', `${preset.id}.xmp`);
    try { await access(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await importPreset(root, source); }
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command, rootArg, sessionId, ...rest] = args;
  const root = path.resolve(rootArg);
  if (command === 'import') return importPreset(root, sessionId);
  if (command === 'delete-preset') return deletePreset(root, rest[0]);
  await seedBundledPresets(root);
  if (command === 'presets') return listPresets(root);
  if (!/^[a-f0-9-]{36}$/i.test(sessionId ?? '')) throw new Error('セッションが無効です');
  const sessionRoot = within(path.join(root, 'sessions'), path.join(root, 'sessions', sessionId));
  const settings = (await new SettingsStore(path.join(root, 'settings.json')).load()).active;
  if (command === 'touch-preview') {
    const source = (await collectSources(path.join(sessionRoot, 'source'))).find(s => s.fileName === rest[0]);
    if (!source) throw new Error('写真が見つかりません');
    return makeTouchPreview(source, sessionRoot);
  }
  if (command === 'list') return {
    ...await listPresets(root), sources: await collectSources(path.join(sessionRoot, 'source')),
    defaultPresetId: (await readJson(path.join(root, 'default-preset.json'), {})).presetId ?? null,
    selections: (await readJson(path.join(sessionRoot, 'selections.json'), { choices: {} })).choices,
    framingChoice: await readJson(path.join(sessionRoot, 'framing-choice.json'), null),
  };
  if (command === 'set-default') {
    const preset = (await listPresets(root)).presets.find(p => p.id === rest[0]);
    if (!preset) throw new Error('標準プリセットが見つかりません');
    await writeJson(path.join(root, 'default-preset.json'), { presetId: preset.id });
    return { presetId: preset.id, name: preset.name };
  }
  if (command === 'choose-product') return chooseProductPreset({ root, sessionRoot, presetId: rest[0], settings });
  if (command === 'top') {
    const sources = await collectSources(path.join(sessionRoot, 'source'));
    if (!sources.some(source => source.fileName === rest[0])) throw new Error('トップ画像が見つかりません');
    await writeJson(path.join(sessionRoot, 'framing-choice.json'), { topFileName: rest[0] });
    return { topFileName: rest[0] };
  }
  if (command === 'confirm-framing') {
    if (!/^[a-f0-9]{64}$/.test(rest[0] ?? '')) throw new Error('構図確認結果が不正です');
    const file = path.join(sessionRoot, 'framing-choice.json');
    const choice = await readJson(file);
    if (!choice.topFileName) throw new Error('トップ画像を指定してください');
    await writeJson(file, { topFileName: choice.topFileName, confirmedPlanHash: rest[0] });
    return { confirmed: true };
  }
  if (command === 'framing-inspect') {
    const sources = await collectSources(path.join(sessionRoot, 'source'));
    const requested = rest[0];
    if (requested && !sources.some(source => source.fileName === requested)) throw new Error('画像が見つかりません');
    const selectedPresets = await validateSelections({ root, sessionRoot, sources, settings });
    const overrides = await readJson(path.join(sessionRoot, 'framing-overrides.json'), {});
    const directory = path.join(sessionRoot, 'framing-inspect'); await mkdir(directory, { recursive: true });
    const items = [];
    for (const source of sources.filter(source => !requested || source.fileName === requested)) {
      const choice = selectedPresets.get(source.fileName);
      const rendered = await renderCachedLightroom({ root, sourcePath: source.sourcePath, preset: choice.preset,
        expectedSignature: choice.signature, longEdgePx: settings.longEdgePx, jpegQuality: 100,
        cacheDir: path.join(sessionRoot, 'comparisons', 'render-cache') }, renderLightroom);
      const level = await estimateStudioLevel(rendered.path);
      const saved = overrides[source.fileName]?.sourceHash === await sha256File(source.sourcePath)
        ? overrides[source.fileName] : null;
      const angle = saved && Number.isFinite(saved.angle) ? saved.angle : level.status === 'READY' ? level.angle : 0;
      const previewPath = path.join(directory, `${source.clientAssetId}.jpg`);
      await sharp(imagePath(rendered.path)).rotate(angle, { background: '#eeeeee' }).jpeg({ quality: 92 }).toFile(imagePath(previewPath));
      const detected = await analyzeStudioPhoto(previewPath);
      const metadata = await sharp(imagePath(previewPath)).metadata();
      items.push({ fileName: source.fileName, path: previewPath, width: metadata.width, height: metadata.height,
        sourceHash: await sha256File(source.sourcePath), angle, levelStatus: level.status,
        subjectBox: saved?.subjectBox ?? (detected.status === 'READY' ? detected.subjectBox : null),
          framingMode:saved?.framingMode??'auto', subjectStatus: saved?.subjectBox ? 'MANUAL' : detected.status });
    }
    return { items };
  }
  if (command === 'framing-override') {
    const [fileName, angleText, boxText, framingMode='whole'] = rest;
    const sources = await collectSources(path.join(sessionRoot, 'source'));
    const source = sources.find(item => item.fileName === fileName);
    if (!source) throw new Error('画像が見つかりません');
    const angle = Number(angleText), subjectBox = JSON.parse(boxText);
    if (!['whole','detail'].includes(framingMode)||!Number.isFinite(angle) || Math.abs(angle) > 5 ||
      (framingMode!=='detail'&&(!subjectBox || !['left', 'top', 'width', 'height'].every(key => Number.isInteger(subjectBox[key])))))
      throw new Error('水平角または被写体範囲が不正です');
    const file = path.join(sessionRoot, 'framing-overrides.json');
    const overrides = await readJson(file, {});
    overrides[fileName] = { angle, subjectBox, framingMode, sourceHash: await sha256File(source.sourcePath) };
    await writeJson(file, overrides);
    return { saved: true, fileName };
  }
  if (command === 'framing-preview' || command === 'framing-export') {
    const sources = await collectSources(path.join(sessionRoot, 'source'));
    const selectedPresets = await validateSelections({ root, sessionRoot, sources, settings });
    const topFileName = (await readJson(path.join(sessionRoot, 'framing-choice.json'))).topFileName;
    const overrides = await readJson(path.join(sessionRoot, 'framing-overrides.json'), {});
    const plan = await prepareProductFraming({ sources, topFileName, selectedPresets, outputRoot: sessionRoot,
      render: renderLightroom, stationRoot: root, settings, overrides });
    if (plan.status !== 'READY') return plan;
    const previews = [];
    const exporting = command === 'framing-export';
    const sharedEdge = exporting ? Math.min(settings.longEdgePx,
      ...Object.values(plan.crops).filter(Boolean).map(crop => Math.max(crop.width, crop.height))) : 700;
    const logoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'BelloStamp.png');
    for (const source of sources) {
      const frame = plan.frames.get(source.clientAssetId);
      const preview = exporting
        ? path.join(sessionRoot, 'redo-export', `${source.clientAssetId}.jpg`)
        : path.join(sessionRoot, 'framing', `${source.clientAssetId}-preview.jpg`);
      await processImage({ sourcePath: frame.path, processedPath: preview,
        thumbnailPath: exporting ? path.join(sessionRoot, 'redo-export', 'thumbnails', `${source.clientAssetId}.jpg`)
          : path.join(sessionRoot, 'framing', `${source.clientAssetId}-preview-thumb.jpg`),
        settings: { ...settings, lightroomPresetName: null, longEdgePx: sharedEdge, thumbnailLongEdgePx: exporting ? settings.thumbnailLongEdgePx : 180,
          brightness: 0, contrast: 0, colorTemperatureShift: 0, saturation: 0, sharpness: 0,
          productCrop: plan.crops[source.clientAssetId],
          productContainAspectRatio: plan.crops[source.clientAssetId] ? null : plan.aspectRatio },
        stamp: source.clientAssetId === plan.topAssetId ? { logoPath,
          geometry: { sourceWidth: frame.width, sourceHeight: frame.height,
            subjectBox: frame.subjectBox, crop: plan.crops[source.clientAssetId] } } : null });
      previews.push({ fileName: source.fileName, path: preview, angle: frame.angle });
    }
    return { status: plan.status, aspectRatio: plan.aspectRatio, confirmationHash: plan.confirmationHash, previews };
  }
  if (command === 'preview') return generateComparisons({ root, sessionRoot, representative: rest[0], settings, onProgress: console.log });
  if (command === 'preview-pair') return generateComparisons({ root, sessionRoot, representative: rest[0], settings,
    presetIds: JSON.parse(rest[1]), onProgress: console.log });
  if (command === 'choose') return choosePreset({ root, sessionRoot, comparisonId: rest[0], presetId: rest[1], sourceNames: JSON.parse(rest[2]), settings });
  throw new Error('Unknown preset command');
}
if (isMainModule(import.meta.url)) {
  main().then(result => console.log(`RESULT_JSON:${JSON.stringify(result)}`)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
