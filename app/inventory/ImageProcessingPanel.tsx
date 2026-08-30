"use client";

import { useEffect, useState } from "react";
import { listImageProcessingVersionsAction, reprocessImageAction, rollbackImageVersionAction, type ImageProcessingVersionSummary } from "@/app/actions/imageProcessing";

/**
 * BELLO画像自動加工システム(2026-08-30指示書)§13: 「各サムネイルに
 * 『未加工』『加工待ち』『加工中』『加工済』『要確認』『再加工中』
 * 『失敗』をテキスト＋アイコン等で表示」「商品単位に『10/10加工完了』
 * 等を表示」の実装。InventoryImageGallery.tsx自体は変更しない
 * (既存のnormal/damage両対応・lightbox実装を触らずに済む、この
 * パネルは商品画像セクションの下に独立して表示する構成)。
 *
 * 「Profile再解析」「基準値の自動調整」は実装していない
 * (SubjectSegmentationProvider未実装のため、composition confidenceは
 * 常にnull——このパネルのSTATUS_LABELSでは「要確認」表示に現れる)。
 */
const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  UNPROCESSED: { label: "未加工", className: "text-gray-400" },
  QUEUED: { label: "加工待ち", className: "text-gray-500" },
  PROCESSING: { label: "加工中", className: "text-blue-600" },
  READY: { label: "加工済", className: "text-emerald-700" },
  NEEDS_REVIEW: { label: "要確認", className: "text-amber-700" },
  FAILED: { label: "失敗", className: "text-red-600" },
  REPROCESSING: { label: "再加工中", className: "text-blue-600" },
  DEAD_LETTER: { label: "失敗(リトライ上限)", className: "text-red-600" },
};

interface ImagePanelRow {
  storageKey: string;
  originalHash: string | null;
}

function currentStatus(versions: ImageProcessingVersionSummary[]): string {
  const active = versions.find((v) => v.active);
  if (active) return active.status;
  if (versions.length === 0) return "UNPROCESSED";
  // ACTIVEが無い(処理中/失敗のみ)場合は最新versionの状態を見せる。
  return versions[versions.length - 1].status;
}

export function ImageProcessingPanel({ inventoryId, images }: { inventoryId: string; images: ImagePanelRow[] }) {
  const [byKey, setByKey] = useState<Record<string, ImageProcessingVersionSummary[]> | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const entries = await Promise.all(images.map(async (img) => [img.storageKey, await listImageProcessingVersionsAction(img.storageKey)] as const));
    setByKey(Object.fromEntries(entries));
  }

  useEffect(() => {
    if (images.length === 0) return;
    refresh().catch((err) => setError(err instanceof Error ? err.message : "読み込みに失敗しました。"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- imagesは親から毎レンダー新配列で渡り得るため、storageKeyの並びをJSON化した依存にする
  }, [JSON.stringify(images.map((i) => i.storageKey))]);

  if (images.length === 0 || byKey === null) return null;

  const readyCount = images.filter((img) => currentStatus(byKey[img.storageKey] ?? []) === "READY").length;
  const needsReviewCount = images.filter((img) => currentStatus(byKey[img.storageKey] ?? []) === "NEEDS_REVIEW").length;
  const failedCount = images.filter((img) => ["FAILED", "DEAD_LETTER"].includes(currentStatus(byKey[img.storageKey] ?? []))).length;

  async function handleReprocess(img: ImagePanelRow) {
    setBusyKey(img.storageKey);
    setError(null);
    try {
      await reprocessImageAction({ inventoryId, imageStorageKey: img.storageKey, originalHash: img.originalHash ?? "" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "再加工の予約に失敗しました。");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRollback(img: ImagePanelRow, versionId: string) {
    setBusyKey(img.storageKey);
    setError(null);
    try {
      await rollbackImageVersionAction(inventoryId, img.storageKey, versionId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ロールバックに失敗しました。");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="mt-3 border-t border-gray-100 pt-2">
      <p className="mb-1.5 text-[11px] font-bold text-gray-400">
        画像加工状況: {readyCount}/{images.length}加工完了
        {needsReviewCount > 0 && ` ・${needsReviewCount}件要確認`}
        {failedCount > 0 && ` ・${failedCount}件失敗`}
      </p>
      {error && <p className="mb-1.5 text-[11px] text-red-600">{error}</p>}
      <ul className="space-y-1">
        {images.map((img, i) => {
          const versions = byKey[img.storageKey] ?? [];
          const status = currentStatus(versions);
          const meta = STATUS_LABELS[status] ?? { label: status, className: "text-gray-500" };
          const superseded = versions.filter((v) => v.status === "SUPERSEDED" || (!v.active && v.status === "READY"));
          return (
            <li key={img.storageKey} className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-gray-500">画像{i + 1}:</span>
              <span className={`font-bold ${meta.className}`}>{meta.label}</span>
              <button
                type="button"
                onClick={() => handleReprocess(img)}
                disabled={busyKey === img.storageKey}
                className="text-gray-400 hover:text-gray-900 disabled:opacity-50"
              >
                再加工
              </button>
              {superseded.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleRollback(img, superseded[superseded.length - 1].id)}
                  disabled={busyKey === img.storageKey}
                  className="text-gray-400 hover:text-gray-900 disabled:opacity-50"
                >
                  直前版に戻す
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
