import path from "node:path";
import {originalArchiveId} from "./originalArchive.mjs";
import {readSourceExpiry,REDO_WINDOW_MS} from "./retention.mjs";
import { fileURLToPath } from 'node:url';
import { processImage, sha256File } from "./processImage.mjs";
import { settingsHash } from "./settings.mjs";
import { uploadSavedPhotos } from "./uploadSave.mjs";
import { renderLightroom } from './lightroomRenderer.mjs';
import { prepareProductFraming } from './productFraming.mjs';
import { exportLocalPhotos, validateExportDirectory } from './localExport.mjs';

export const STAGE = Object.freeze({
  EDITING: "編集中",
  EDITED: "編集完了",
  UPLOADING: "アップロード中",
  UPLOADED: "アップロード完了",
  PARTIAL_FAILURE: "一部失敗",
  RETRYABLE: "再実行可能",
  SAFE_TO_EJECT: "SDカードを安全に取り外せる状態",
});

/**
 * 「設定読込 → 一括編集 → プレビュー用メタ生成 → 検証環境へアップロード →
 * 履歴保存」をまとめて実行する。原本(source.sourcePath)は読むだけで、
 * 書き込みは processed/thumbnails の派生ファイルと履歴JSONだけに限定する。
 *
 * 同じ sessionId で再実行すると、原本ハッシュ＋設定ハッシュが変わって
 * いない画像は再加工しない(history)。アップロード側もサーバ契約の
 * idempotency(同一clientAssetId+hashはALREADY_READY/DUPLICATE_SKIP)に
 * 任せているため、失敗後の再実行がそのまま安全な再送になる。
 */
export async function runEditAndUploadPipeline({
  sessionId,
  sources,
  settings,
  outputRoot,
  history,
  api,
  deviceId,
  sdCardId = null,
  onStatus = () => {},
  selectedPresets = null,
  stationRoot,
  render = renderLightroom,
  framingTopFileName = null,
  confirmedFramingHash = null,
  framingOverrides = {},
  prepareFraming = prepareProductFraming,
  stampLogoPath = fileURLToPath(new URL('../assets/BelloStamp.png', import.meta.url)),
  destination = 'web',
  exportDirectory = null,
}) {
  if (!['web', 'pc', 'shared'].includes(destination)) throw new Error('保存先の種類が不正です');
  const protectedRoots = [stationRoot, outputRoot, fileURLToPath(new URL('../../', import.meta.url)), ...sources.map(s => path.dirname(s.sourcePath))];
  if (destination !== 'web') await validateExportDirectory(exportDirectory, protectedRoots);
  if (selectedPresets && sources.some(s => !selectedPresets.has(s.fileName))) throw new Error('未選択の写真があります');
  const processedDir = path.join(outputRoot, "processed");
  const thumbnailDir = path.join(outputRoot, "thumbnails");

  let framing = null;
  if (framingTopFileName) {
    onStatus('商品ごとの構図と水平を確認中');
    framing = await prepareFraming({ sources, topFileName: framingTopFileName, selectedPresets,
      outputRoot, render, stationRoot, settings, overrides: framingOverrides });
    if (framing.status !== 'READY') {
      onStatus(STAGE.RETRYABLE);
      return { status: 'FAILED', editFailures: [{ clientAssetId: '', fileName: framingTopFileName,
        stage: 'FRAMING', message: framing.reason ?? '構図を確認してください' }], uploadFailures: [], uploaded: [] };
    }
    // Safe, deterministic plans are accepted automatically. An explicitly
    // confirmed older plan still fails closed if the source or crop changed.
    if (confirmedFramingHash && confirmedFramingHash !== framing.confirmationHash) {
      onStatus(STAGE.RETRYABLE);
      return { status: 'FAILED', editFailures: [{ clientAssetId: '', fileName: framingTopFileName,
        stage: 'FRAMING', message: '写真・設定・構図が変わりました。プレビューを確認し直してください' }],
      uploadFailures: [], uploaded: [] };
    }
  }

  // Keep every image of one product at the same pixel dimensions without
  // enlarging a smaller crop and making it visibly soft.
  const productOutputLongEdgePx = framing
    ? Math.min(settings.longEdgePx, ...Object.values(framing.crops).filter(Boolean).map(crop => Math.max(crop.width, crop.height)))
    : null;
  const stampHash = framing && stampLogoPath ? await sha256File(stampLogoPath) : null;

  onStatus(STAGE.EDITING);
  const editedAssets = [];
  const editFailures = [];
  for (const source of sources) {
    const choice = selectedPresets?.get(source.fileName);
    const productCrop = framing?.crops[source.clientAssetId] ?? null;
    const frame = framing?.frames.get(source.clientAssetId);
    const hash = settingsHash({ ...settings, selectedPresetHash: choice?.preset.hash ?? null,
      selectedPresetSignature: choice?.signature ?? null, framingTopFileName,
      productCropKey: productCrop ? JSON.stringify(productCrop) : null, productContainAspectRatio: framing && !productCrop ? framing.aspectRatio : null,
      framingAngle: frame?.angle ?? null,
      layoutVersion: 4, stampSubjectBox: frame?.subjectBox ? JSON.stringify(frame.subjectBox) : null,
      productOutputLongEdgePx, topStampHash: source.clientAssetId === framing?.topAssetId ? stampHash : null });
    const processedPath = path.join(processedDir, `${source.clientAssetId}.jpg`);
    const thumbnailPath = path.join(thumbnailDir, `${source.clientAssetId}.jpg`);
    try {
      const sourceHash = await sha256File(source.sourcePath);
      const alreadyDone = await history.isAlreadyProcessed(sessionId, source.clientAssetId, sourceHash, hash);
      let processed;
      let thumbnail;
      if (alreadyDone) {
        const entry = await history.findEntry(sessionId, source.clientAssetId);
        processed = entry.processed;
        thumbnail = entry.thumbnail;
      } else {
        let renderPath = frame?.path ?? source.sourcePath;
        if (choice && !frame) {
          const rendered = await render({ root: stationRoot, sourcePath: source.sourcePath, preset: choice.preset, expectedSignature: choice.signature, longEdgePx: settings.longEdgePx, jpegQuality: 100 });
          renderPath = rendered.path;
        }
        const outputSettings = choice ? { ...settings, lightroomPresetName: null, brightness: 0, contrast: 0, colorTemperatureShift: 0, saturation: 0, sharpness: 0,
          productCrop, productContainAspectRatio: framing && !productCrop ? framing.aspectRatio : null,
          longEdgePx: productOutputLongEdgePx ?? settings.longEdgePx } : settings;
        const stamp = stampHash && source.clientAssetId === framing.topAssetId
          ? { logoPath: stampLogoPath, geometry: { sourceWidth: frame?.width, sourceHeight: frame?.height,
            subjectBox: frame?.subjectBox, crop: productCrop } } : null;
        const result = await processImage({ sourcePath: renderPath, processedPath, thumbnailPath, settings: outputSettings, stamp });
        processed = result.processed;
        thumbnail = result.thumbnail;
        await history.recordProcessed(sessionId, source.clientAssetId, {
          sourceHash,
          settingsHash: hash,
          processed,
          thumbnail,
        });
      }
      editedAssets.push({
        clientAssetId: source.clientAssetId,
        fileName: source.fileName,
        originalPath: source.sourcePath,
        originalArchiveId: originalArchiveId(deviceId,sessionId,source.clientAssetId),
        importedAt: await readSourceExpiry(outputRoot).then(x=>x?new Date(x-REDO_WINDOW_MS).toISOString():null),
        processedPath: processed.path,
        thumbnailPath: thumbnail.path,
        processedDimensions: { width: processed.width, height: processed.height },
        thumbnailDimensions: { width: thumbnail.width, height: thumbnail.height },
      });
    } catch (error) {
      editFailures.push({ clientAssetId: source.clientAssetId, fileName: source.fileName, stage: "EDIT", message: error.message });
    }
  }
  onStatus(STAGE.EDITED);

  if (stampHash && editFailures.some(failure => failure.clientAssetId === framing.topAssetId)) {
    onStatus(STAGE.RETRYABLE);
    return { status: 'FAILED', editFailures, uploadFailures: [], uploaded: [] };
  }

  if (editedAssets.length === 0) {
    onStatus(STAGE.RETRYABLE);
    return { status: editFailures.length > 0 ? "FAILED" : "NO_ASSETS", editFailures, uploadFailures: [], uploaded: [] };
  }

  let uploadResult = null;
  const uploadFailures = [];
  // The web inventory gallery falls back to the lowest asset sequence when
  // no explicit primary is set. Send the framing top image first so the
  // visible primary and the product-wide ratio decision use the same photo.
  const orderedAssets = framing ? [...editedAssets].sort((a, b) =>
    Number(b.clientAssetId === framing.topAssetId) - Number(a.clientAssetId === framing.topAssetId)) : editedAssets;
  if (destination !== 'web') {
    if (editFailures.length) return { status: 'FAILED', editFailures, uploadFailures: [], uploaded: [] };
    onStatus('選択したフォルダーへ保存・照合中');
    try {
      const exported = await exportLocalPhotos({ sessionId, assets: orderedAssets, directory: exportDirectory, protectedRoots });
      onStatus('写真の保存と照合が完了しました');
      return { status: 'SAVED_LOCAL', destination, ...exported, uploaded: [], editFailures: [], uploadFailures: [] };
    } catch (error) {
      return { status: 'FAILED', uploaded: [], editFailures: [], uploadFailures: [{ clientAssetId: '', fileName: '', stage: 'SAVE', message: error.message }] };
    }
  }
  onStatus(STAGE.UPLOADING);
  try {
    uploadResult = await uploadSavedPhotos({
      stateFile: path.join(outputRoot, 'upload-save-state.json'),
      api,
      deviceId,
      sdCardId,
      sessionId,
      assets: orderedAssets,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === "ASSET_READY" && checkpoint.clientAssetId) {
          await history.recordUploadResult(sessionId, checkpoint.clientAssetId, "UPLOADED");
        }
      },
    });
  } catch (error) {
    for (const asset of editedAssets) {
      const entry = await history.findEntry(sessionId, asset.clientAssetId);
      {
        await history.recordUploadResult(sessionId, asset.clientAssetId, "FAILED", { uploadError: error.message });
        uploadFailures.push({ clientAssetId: asset.clientAssetId, fileName: asset.fileName, stage: "UPLOAD", message: error.message });
      }
    }
  }

  const overallFailures = [...editFailures, ...uploadFailures];
  if (uploadResult && overallFailures.length === 0) {
    onStatus(STAGE.UPLOADED);
    onStatus(STAGE.SAFE_TO_EJECT);
    return {
      status: "COMPLETE",
      batchId: uploadResult.batchId,
      batchCode: uploadResult.batchCode,
      uploaded: editedAssets,
      editFailures,
      uploadFailures,
    };
  }
  onStatus(STAGE.PARTIAL_FAILURE);
  onStatus(STAGE.RETRYABLE);
  return {
    status: "PARTIAL",
    batchId: uploadResult?.batchId ?? null,
    uploaded: editedAssets,
    editFailures,
    uploadFailures,
  };
}
