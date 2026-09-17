import path from "node:path";
import { processImage, sha256File } from "./processImage.mjs";
import { settingsHash } from "./settings.mjs";
import { uploadSession } from "./client.mjs";

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
}) {
  const hash = settingsHash(settings);
  const processedDir = path.join(outputRoot, "processed");
  const thumbnailDir = path.join(outputRoot, "thumbnails");

  onStatus(STAGE.EDITING);
  const editedAssets = [];
  const editFailures = [];
  for (const source of sources) {
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
        const result = await processImage({ sourcePath: source.sourcePath, processedPath, thumbnailPath, settings });
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

  if (editedAssets.length === 0) {
    onStatus(STAGE.RETRYABLE);
    return { status: editFailures.length > 0 ? "FAILED" : "NO_ASSETS", editFailures, uploadFailures: [], uploaded: [] };
  }

  onStatus(STAGE.UPLOADING);
  let uploadResult = null;
  const uploadFailures = [];
  try {
    uploadResult = await uploadSession({
      api,
      deviceId,
      sdCardId,
      sessionId,
      assets: editedAssets,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === "ASSET_READY" && checkpoint.clientAssetId) {
          await history.recordUploadResult(sessionId, checkpoint.clientAssetId, "UPLOADED");
        }
      },
    });
  } catch (error) {
    for (const asset of editedAssets) {
      const entry = await history.findEntry(sessionId, asset.clientAssetId);
      if (entry?.uploadStatus !== "UPLOADED") {
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
