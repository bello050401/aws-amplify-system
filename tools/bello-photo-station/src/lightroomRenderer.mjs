import { imagePath } from './imagePath.mjs';
import { mkdir, copyFile, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { sha256File } from './processImage.mjs';
import { readSourceExpiry, REDO_WINDOW_MS } from './retention.mjs';

/** Reuse only a verified render of the exact same source, XMP and output
 * settings. Lightroom can take minutes per RAW; preview and final processing
 * otherwise repeat the same conversion several times per image. */
export async function renderCachedLightroom(options, render = renderLightroom) {
  const { cacheDir, sourcePath, preset, expectedSignature, longEdgePx, jpegQuality, preserveFraming = false } = options;
  if (!cacheDir) return render(options);
  const sourceHash = await sha256File(sourcePath);
  const key = createHash('sha256').update(JSON.stringify({ version: 1, sourceHash,
    presetId: preset?.id ?? null, presetHash: preset?.hash ?? null,
    expectedSignature: expectedSignature ?? null, longEdgePx, jpegQuality, preserveFraming })).digest('hex');
  const image = path.join(cacheDir, `${key}.jpg`);
  const manifestFile = path.join(cacheDir, `${key}.json`);
  try {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest.version === 1 && (!expectedSignature || manifest.signature === expectedSignature)
      && manifest.sha256 === await sha256File(image)) {
      const metadata = await sharp(imagePath(image)).metadata();
      if (metadata.format === 'jpeg' && metadata.width && metadata.height)
        return { path: image, signature: manifest.signature, cacheHit: true, sourceHash };
    }
  } catch { /* A missing or damaged cache is regenerated, never uploaded. */ }
  const rendered = await render(options);
  if (expectedSignature && rendered.signature !== expectedSignature)
    throw new Error('Lightroomのプリセットが変わりました。再比較してください');
  const metadata = await sharp(imagePath(rendered.path)).metadata();
  if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height)
    throw new Error('Lightroomの出力が不正です');
  await mkdir(cacheDir, { recursive: true });
  const temporary = `${image}.${randomUUID()}.tmp`;
  await copyFile(rendered.path, temporary);
  await rename(temporary, image);
  const value = { version: 1, signature: rendered.signature, sha256: await sha256File(image) };
  const manifestTemporary = `${manifestFile}.${randomUUID()}.tmp`;
  await writeFile(manifestTemporary, JSON.stringify(value));
  await rename(manifestTemporary, manifestFile);
  return { path: image, signature: rendered.signature, cacheHit: false, sourceHash };
}

// A data-only protocol. No Lua or shell code is accepted from queue files.
const hex = s => Buffer.from(String(s), 'utf8').toString('hex');
export async function renderLightroom({ root, sourcePath, preset, longEdgePx = 3000, jpegQuality = 90, timeoutMs = 180000,
  waitForReadyMs = process.env.BELLO_LIGHTROOM_WAIT_FOR_START === '1' ? 60000 : 0, expectedSignature, preserveFraming = false }) {
  // The desktop test build can use the already installed Lightroom service.
  // Its requests use fresh UUIDs and disposable copies; normal photo sessions,
  // settings and registered presets are never edited.
  const serviceRoot = process.env.BELLO_LIGHTROOM_BRIDGE_ROOT || root;
  const bridge = path.join(serviceRoot, 'lightroom');
  let heartbeat;
  const readyUntil = Date.now() + Math.min(timeoutMs, waitForReadyMs);
  do {
    try { heartbeat = JSON.parse(await readFile(path.join(bridge, 'heartbeat.json'), 'utf8')); } catch {}
    if (heartbeat && Date.now() - heartbeat.unixMs < 15000 && heartbeat.protocol === 2) break;
    if (Date.now() >= readyUntil)
      throw new Error('Lightroom連携が停止しています。Lightroomで「BELLO連携を開始」を実行してから、保存を再実行してください');
    await delay(400);
  } while (true);
  const id = randomUUID();
  const job = path.join(bridge, 'jobs', id);
  await mkdir(job, { recursive: true });
  await mkdir(path.join(bridge, 'requests'), { recursive: true });
  // Lightroom's own catalog/progress UI shows this file's name to the operator;
  // a generic "input.jpg" for every job makes it look like the wrong photo was picked.
  const input = path.join(job, path.basename(sourcePath));
  // The bridge keeps its own pre-edit copy. Give it the same import deadline
  // so deleting sessions/source never leaves a second original indefinitely.
  const sourceExpiry = await readSourceExpiry(path.dirname(path.dirname(sourcePath)));
  await writeFile(path.join(job, 'job-retention.json'), JSON.stringify({ version: 1,
    expiresAt: new Date(sourceExpiry ?? Date.now() + REDO_WINDOW_MS).toISOString(), inputName: path.basename(input) }));
  await copyFile(sourcePath, input);
  let presetFile = preset?.file ?? '';
  if (presetFile && path.resolve(serviceRoot) !== path.resolve(root)) {
    // The installed plugin validates preset paths beneath its own root.
    // A dedicated subdirectory keeps temporary test presets out of the normal
    // application's top-level preset list and prevents name collisions.
    const testPresets = path.join(serviceRoot, 'presets', 'desktop-test-jobs', id);
    await mkdir(testPresets, { recursive: true });
    presetFile = path.join(testPresets, 'preset.xmp');
    await copyFile(preset.file, presetFile);
  }
  // Preset matching also uses its UUID; filenames/display names may be duplicated.
  const fields = ['BELLO2', id, input, preset?.id ?? '', presetFile, longEdgePx, jpegQuality, Date.now() + timeoutMs, expectedSignature ?? ''];
  if (preserveFraming) fields.push('KEEP_FRAME');
  const body = fields.map(hex).join('\n');
  const ready = path.join(bridge, 'requests', `${id}.ready`);
  await writeFile(ready + '.tmp', body); await rename(ready + '.tmp', ready);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let result;
    try { result = JSON.parse(await readFile(path.join(job, 'result.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (result) {
      if (!result.ok) {
        if (/unless Lightroom is licensed/i.test(result.error ?? ''))
          throw new Error('Lightroom Classicのライセンス認証が完了していません。LightroomでAdobeへのログインと契約状態を確認してください。写真と調整した位置は保存されています');
        throw new Error(result.error ?? 'Lightroomでの現像に失敗しました');
      }
      if (preserveFraming && result.preserveFraming !== true) throw new Error('Lightroom連携を最新版に更新してください。位置調整を保持できないため保存を止めました');
      if (expectedSignature && result.signature !== expectedSignature) throw new Error('Lightroomのプリセットが変わりました。再比較してください');
      const output = path.join(job, 'render.jpg');
      const metadata = await sharp(imagePath(output)).metadata();
      if (!metadata.width || !metadata.height || metadata.format !== 'jpeg') throw new Error('Lightroomの出力が不正です');
      return { path: output, signature: result.signature };
    }
    await delay(400);
  }
  await writeFile(path.join(job, 'cancelled'), 'timeout');
  throw new Error('Lightroomの処理が時間内に完了しませんでした。原本は保持されています');
}
