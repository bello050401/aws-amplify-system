import { readFile, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

export const NON_RETRYABLE_CODES = new Set(["IDEMPOTENCY_CONFLICT", "INVALID_INPUT", "PERMISSION_DENIED"]);

export async function describeFile(path, mimeType = "image/jpeg") {
  const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
  return { mimeType, fileSize: info.size, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export class PhotoRegistrationApiClient {
  constructor({ endpoint, tokenProvider, fetchImpl = fetch, retries = 3 }) {
    if (!endpoint || !/^https:\/\//.test(endpoint)) throw new Error("PHOTO_STATION_API_URL must be an https URL");
    this.endpoint = endpoint.replace(/\/$/, "");
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImpl;
    this.retries = retries;
  }

  async call(operation, input) {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.tokenProvider();
      let response;
      try { response = await this.fetch(`${this.endpoint}/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(60000),
      }); } catch(error) { if(attempt>=this.retries)throw new Error('通信が切断されました。取込済み写真から再実行できます。',{cause:error});await new Promise(r=>setTimeout(r,Math.min(500*2**attempt,4000)));continue; }
      const body = await response.json().catch(() => ({ ok: false, error: { code: "HTTP_ERROR", message: `HTTP ${response.status}` } }));
      if (response.ok && body.ok) return body.value;
      const code = body?.error?.code ?? "HTTP_ERROR";
      if (NON_RETRYABLE_CODES.has(code) || attempt >= this.retries) throw Object.assign(new Error(body?.error?.message ?? `HTTP ${response.status}`), { code });
      if (code === "CONFLICT" || response.status >= 500 || response.status === 429) await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** attempt, 2000)));
      else throw Object.assign(new Error(body?.error?.message ?? `HTTP ${response.status}`), { code });
    }
  }

  async upload(upload, filePath) {
    const bytes = await readFile(filePath);
    const checksumInQuery = new URL(upload.uploadUrl).searchParams.has("x-amz-checksum-sha256");
    const headers = {
      "content-type": upload.expectedMimeType,
      "content-length": String(upload.expectedBytes),
      ...(!checksumInQuery ? { "x-amz-checksum-sha256": Buffer.from(upload.expectedSha256, "hex").toString("base64") } : {}),
    };
    for(let attempt=0;;attempt++){
    let response;
    try{response = await this.fetch(upload.uploadUrl, {
      method: "PUT",
      headers,
      body: bytes,signal:AbortSignal.timeout(120000),
    });}catch(error){if(attempt>=this.retries)throw new Error('写真のアップロードが中断しました。原本はPCに保持しています。',{cause:error});await new Promise(r=>setTimeout(r,Math.min(500*2**attempt,4000)));continue;}
    if((response.status>=500||response.status===429)&&attempt<this.retries){await new Promise(r=>setTimeout(r,Math.min(500*2**attempt,4000)));continue;}
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`S3 PUT failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ""}`);
    }
    return;
    }
  }
}

export function chunk(items, size = 25) {
  if (!Number.isInteger(size) || size < 1 || size > 25) throw new Error("chunk size must be 1..25");
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export async function uploadSession({ api, deviceId, sdCardId = null, sessionId = randomUUID(), assets, onCheckpoint = async () => {} }) {
  const prepared = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    prepared.push({
      clientAssetId: asset.clientAssetId ?? `${sessionId}-${String(index + 1).padStart(3, "0")}`,
      fileName: asset.fileName,
      originalPath: asset.originalPath,
      originalArchiveId: asset.originalArchiveId,
      original: asset.originalPath ? {...await describeFile(asset.originalPath,"application/octet-stream"),fileName:asset.fileName,importedAt:asset.importedAt??null} : null,
      processedPath: asset.processedPath,
      thumbnailPath: asset.thumbnailPath,
      processed: await describeFile(asset.processedPath),
      thumbnail: await describeFile(asset.thumbnailPath),
      processedDimensions: asset.processedDimensions,
      thumbnailDimensions: asset.thumbnailDimensions,
    });
  }
  const batch = await api.call("createPhotoBatch", { localImportSessionId: sessionId, sourceDeviceId: deviceId, sourceSdCardId: sdCardId, imageCountOriginal: assets.length, expectedAssetCount: assets.length });
  await onCheckpoint({ sessionId, batchId: batch.batchId, phase: "BATCH_CREATED" });
  let uploaded = 0;
  let duplicateSkips = 0;
  for (const group of chunk(prepared)) {
    const response = await api.call("requestPhotoAssetUploads", { batchId: batch.batchId, assets: group.map(({ clientAssetId, fileName, processed, thumbnail }) => ({ clientAssetId, fileName, processed, thumbnail })) });
    for (const item of response.items) {
      const local = group.find((x) => x.clientAssetId === item.clientAssetId);
      if (item.kind === "DUPLICATE_SKIP") { duplicateSkips += 1; await onCheckpoint({ sessionId, batchId: batch.batchId, clientAssetId: item.clientAssetId, phase: "ASSET_READY" }); continue; }
      if (item.kind === "ALREADY_READY") { await uploadOriginal(api,item.photoAssetId,local); uploaded += 1; await onCheckpoint({ sessionId, batchId: batch.batchId, clientAssetId: item.clientAssetId, phase: "ASSET_READY" }); continue; }
      for (const target of item.uploads) await api.upload(target, target.variant === "PROCESSED" ? local.processedPath : local.thumbnailPath);
      await api.call("completePhotoAssetUpload", {
        photoAssetId: item.photoAssetId,
        processed: { sha256: local.processed.sha256, fileSize: local.processed.fileSize, ...local.processedDimensions },
        thumbnail: { sha256: local.thumbnail.sha256, fileSize: local.thumbnail.fileSize, ...local.thumbnailDimensions },
      });
      await uploadOriginal(api,item.photoAssetId,local);
      uploaded += 1;
      await onCheckpoint({ sessionId, batchId: batch.batchId, clientAssetId: item.clientAssetId, phase: "ASSET_READY" });
    }
  }
  const expected = prepared.length - duplicateSkips;
  const completed = await api.call("completePhotoBatch", { batchId: batch.batchId, imageCountProcessed: expected, imageCountUploaded: uploaded });
  await onCheckpoint({ sessionId, batchId: batch.batchId, phase: "COMPLETE" });
  return { ...completed, batchCode: batch.batchCode, uploaded, duplicateSkips };
}

async function uploadOriginal(api,photoAssetId,local){
 if(!local.originalPath)return;
 const result=await api.call("requestOriginalPhotoUpload",{photoAssetId,archiveId:local.originalArchiveId,original:local.original});
 if(result.status==="UPLOAD"){
  await api.upload(result.upload,local.originalPath);
  const completed=await api.call("completeOriginalPhotoUpload",{photoAssetId,archiveId:local.originalArchiveId});
  if(completed.status!=="READY")throw Error("編集前写真の保存を確認できません。再実行してください。");
 }else if(result.status==="READY"&&local.originalArchiveId){
  await api.call("completeOriginalPhotoUpload",{photoAssetId,archiveId:local.originalArchiveId});
 }else if(result.status!=="READY")throw Error("編集前写真の保存状態を確認できません。保管期限と取込履歴を確認してください。");
}
