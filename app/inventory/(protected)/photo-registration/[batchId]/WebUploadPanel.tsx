"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { completeWebAssetUploadAction, finalizeWebUploadAction, requestWebAssetUploadsAction, type WebUploadAssetInput } from "@/app/actions/photoRegistration";
import { MAX_PROCESSED_BYTES, WEB_UPLOAD_PROCESSED_MIME_TYPES } from "@/lib/photoRegistration/types";

/** lib/photoRegistration/webAdapter.ts の MAX_WEB_UPLOAD_FILES_PER_REQUEST と一致させること
 * ("server-only" なwebAdapter.tsはクライアントバンドルへ直接importできないため値を複製している)。 */
const MAX_FILES_PER_UPLOAD = 20;
const THUMBNAIL_MAX_DIMENSION = 640;

type FileStatus = "queued" | "hashing" | "uploading" | "completing" | "done" | "error" | "skipped";

interface FileEntry {
  id: string; // clientAssetId
  file: File;
  status: FileStatus;
  message?: string;
}

const FILE_STATUS_LABEL: Record<FileStatus, string> = {
  queued: "待機中",
  hashing: "検証中",
  uploading: "アップロード中",
  completing: "確認中",
  done: "完了",
  error: "失敗",
  skipped: "スキップ",
};

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildThumbnail(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context is not available");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("thumbnail generation failed"))), "image/jpeg", 0.85);
    });
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}

async function readDimensions(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close();
  return { width, height };
}

function validateFileClientSide(file: File): string | null {
  if (!(WEB_UPLOAD_PROCESSED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `対応していない形式です(JPEG/PNG/WebPのみ): ${file.name}`;
  }
  if (file.size > MAX_PROCESSED_BYTES) {
    return `ファイルサイズが大きすぎます(上限${Math.floor(MAX_PROCESSED_BYTES / 1024 / 1024)}MB): ${file.name}`;
  }
  return null;
}

interface ResponseItem {
  kind: string;
  clientAssetId: string;
  photoAssetId: string;
  uploads?: { variant: "PROCESSED" | "THUMBNAIL"; s3Key: string; uploadUrl: string | null; expectedMimeType: string; expectedSha256: string }[];
}

/**
 * Web追加upload (docs/photo-registration-api-v1.md §13)。画像バイナリは
 * サーバーを経由せず、requestWebAssetUploadsActionが返す署名付きURLへ
 * ブラウザから直接PUTする — このコンポーネントもサーバーもAWS認証情報を
 * 一切保持しない。
 */
export function WebUploadPanel({ batchId, batchStatus }: { batchId: string; batchStatus: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const archived = batchStatus === "ARCHIVED";

  function handleFilesSelected(fileList: FileList | null) {
    setFormError(null);
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    if (files.length > MAX_FILES_PER_UPLOAD) {
      setFormError(`一度に選択できる画像は${MAX_FILES_PER_UPLOAD}枚までです(選択: ${files.length}枚)。`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    for (const file of files) {
      const validationError = validateFileClientSide(file);
      if (validationError) {
        setFormError(validationError);
        if (inputRef.current) inputRef.current.value = "";
        return;
      }
    }
    setEntries(files.map((file) => ({ id: crypto.randomUUID(), file, status: "queued" as FileStatus })));
  }

  function updateEntry(id: string, patch: Partial<FileEntry>) {
    setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }

  async function handleSubmit() {
    if (submitting || entries.length === 0) return; // 二重送信防止
    setSubmitting(true);
    setFormError(null);

    try {
      const prepared: {
        entry: FileEntry;
        input: WebUploadAssetInput;
        processedBytes: ArrayBuffer;
        thumbnailBytes: ArrayBuffer;
        dims: { width: number; height: number };
        thumbDims: { width: number; height: number };
      }[] = [];

      for (const entry of entries) {
        updateEntry(entry.id, { status: "hashing" });
        const processedBytes = await entry.file.arrayBuffer();
        const processedSha256 = await sha256Hex(processedBytes);
        const dims = await readDimensions(entry.file);
        const thumbnail = await buildThumbnail(entry.file);
        const thumbnailBytes = await thumbnail.blob.arrayBuffer();
        const thumbnailSha256 = await sha256Hex(thumbnailBytes);
        prepared.push({
          entry,
          dims,
          thumbDims: { width: thumbnail.width, height: thumbnail.height },
          processedBytes,
          thumbnailBytes,
          input: {
            clientAssetId: entry.id,
            fileName: entry.file.name,
            processed: { mimeType: entry.file.type, fileSize: entry.file.size, sha256: processedSha256 },
            thumbnail: { mimeType: "image/jpeg", fileSize: thumbnail.blob.size, sha256: thumbnailSha256 },
          },
        });
      }

      // READY_FOR_REVIEW/LINKEDへの追加は新しいrevisionを開く必要がある(§13)。
      // CREATED/UPLOADINGはPhoto Station側の通常受入と同じ経路で足りる。
      const opensRevision = batchStatus === "READY_FOR_REVIEW" || batchStatus === "LINKED";
      const requested = await requestWebAssetUploadsAction(
        batchId,
        prepared.map((p) => p.input),
        opensRevision ? prepared.length : null,
      );
      if (!requested.ok) {
        setFormError(requested.message);
        for (const p of prepared) updateEntry(p.entry.id, { status: "error", message: requested.message });
        return;
      }

      const items = requested.value.items as ResponseItem[];
      const byClientId = new Map(items.map((item) => [item.clientAssetId, item]));

      for (const p of prepared) {
        const item = byClientId.get(p.entry.id);
        if (!item) {
          updateEntry(p.entry.id, { status: "error", message: "サーバーの応答に画像が含まれていませんでした。" });
          continue;
        }
        if (item.kind === "ALREADY_READY" || item.kind === "DUPLICATE_SKIP") {
          updateEntry(p.entry.id, {
            status: "skipped",
            message: item.kind === "DUPLICATE_SKIP" ? "同じ画像が既に登録済みです。" : "既にアップロード済みです。",
          });
          continue;
        }
        if (!item.uploads) {
          updateEntry(p.entry.id, { status: "error", message: "アップロード先URLを取得できませんでした。" });
          continue;
        }

        updateEntry(p.entry.id, { status: "uploading" });
        try {
          for (const upload of item.uploads) {
            if (!upload.uploadUrl) throw new Error("uploadUrl is missing");
            const body = upload.variant === "PROCESSED" ? p.processedBytes : p.thumbnailBytes;
            const res = await fetch(upload.uploadUrl, {
              method: "PUT",
              headers: { "Content-Type": upload.expectedMimeType, "x-amz-checksum-sha256": hexToBase64(upload.expectedSha256) },
              body,
            });
            if (!res.ok) throw new Error(`S3 PUT failed: ${res.status}`);
          }
        } catch (uploadError) {
          updateEntry(p.entry.id, { status: "error", message: "画像のアップロードに失敗しました。" });
          console.error("[WebUploadPanel] S3 PUT failed", uploadError);
          continue;
        }

        updateEntry(p.entry.id, { status: "completing" });
        const completed = await completeWebAssetUploadAction(batchId, {
          photoAssetId: item.photoAssetId,
          processed: { sha256: p.input.processed.sha256, fileSize: p.input.processed.fileSize, width: p.dims.width, height: p.dims.height },
          thumbnail: { sha256: p.input.thumbnail.sha256, fileSize: p.input.thumbnail.fileSize, width: p.thumbDims.width, height: p.thumbDims.height },
        });
        if (!completed.ok) {
          updateEntry(p.entry.id, { status: "error", message: completed.message });
          continue;
        }
        updateEntry(p.entry.id, { status: "done" });
      }

      const finalized = await finalizeWebUploadAction(batchId);
      if (!finalized.ok) {
        setFormError(`アップロードは完了しましたが、確定処理に失敗しました: ${finalized.message}`);
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (archived) {
    return <p className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-500">このバッチは破棄済みのため画像を追加できません。</p>;
  }

  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <label htmlFor="photo-registration-web-upload-input" className="mb-1 block text-xs font-medium text-gray-700">
        画像ファイルを選択(JPEG/PNG/WebP、最大{MAX_FILES_PER_UPLOAD}枚、1枚あたり最大{Math.floor(MAX_PROCESSED_BYTES / 1024 / 1024)}MB)
      </label>
      <input
        id="photo-registration-web-upload-input"
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        disabled={submitting}
        onChange={(e) => handleFilesSelected(e.target.files)}
        className="block w-full text-xs text-gray-700"
      />
      {formError ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {formError}
        </p>
      ) : null}
      {entries.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 text-xs text-gray-700">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{entry.file.name}</span>
              <span aria-live="polite" className={entry.status === "error" ? "text-red-600" : "text-gray-500"}>
                {FILE_STATUS_LABEL[entry.status]}
                {entry.message ? `: ${entry.message}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting || entries.length === 0}
        className="mt-3 min-h-8 rounded bg-gray-900 px-4 text-xs font-bold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "アップロード中…" : `選択した${entries.length}枚を追加`}
      </button>
    </div>
  );
}
