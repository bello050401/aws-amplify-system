"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { archiveUnlinkedPhotoBatchAction } from "@/app/actions/photoRegistration";
import type { PhotoBatchView } from "@/lib/photoRegistration/types";
import { PhotoBatchCover } from "./PhotoBatchCover";

const STATUS_LABEL: Record<string, string> = {
  CREATED: "作成済み(撮影中)",
  UPLOADING: "アップロード中",
  READY_FOR_REVIEW: "確認待ち",
  LINKED: "紐付け済み",
  ARCHIVED: "破棄",
  ERROR: "エラー",
};

/** リンクだけで前後ページを行き来する — カーソルはURLに載るのでリロード・共有・戻る操作がそのまま効く。 */
export function PhotoBatchListTable({
  batches,
  nextCursor,
  hasCursor,
}: {
  batches: PhotoBatchView[];
  nextCursor: string | null;
  hasCursor: boolean;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function removeBatch(batch: PhotoBatchView) {
    if (!window.confirm(`${batch.batchCode} を一覧から削除しますか？\n紐付け済みのバッチは削除できません。`)) return;
    setError(null);
    setDeleting(batch.id);
    try {
      const result = await archiveUnlinkedPhotoBatchAction(batch.id);
      if (!result.ok) {
        setError(`${batch.batchCode}: ${result.message}`);
        return;
      }
      window.dispatchEvent(new Event("bello:photo-batches-changed"));
      router.refresh();
    } catch {
      setError(`${batch.batchCode}: 削除できませんでした。もう一度お試しください。`);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {batches.length === 0 ? (
        <div className="p-8 text-center text-sm text-gray-500">このページに表示するバッチはありません。</div>
      ) : (
        <ul className="divide-y divide-gray-200 rounded border border-gray-200 bg-white">
          {batches.map((batch) => (
            <li key={batch.id} className="flex items-center gap-3 p-3">
              <PhotoBatchCover batchId={batch.id} />
              <Link
                href={`/inventory/photo-registration/${batch.id}`}
                className="flex min-w-0 flex-1 items-center justify-between gap-4 rounded px-1 py-2 hover:bg-gray-50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">{batch.batchCode}</p>
                  <p className="text-xs text-gray-500">
                    {STATUS_LABEL[batch.status] ?? batch.status} ・ 登録 {batch.manifest.registeredAssetCount}/{batch.manifest.expectedAssetCount}枚 ・ 完了{" "}
                    {batch.manifest.completedAssetCount}枚
                    {batch.manifest.failedAssetCount > 0 ? ` ・ 失敗${batch.manifest.failedAssetCount}枚` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-gray-400">詳細を見る →</span>
              </Link>
              <button
                type="button"
                onClick={() => void removeBatch(batch)}
                disabled={deleting !== null}
                aria-label={`${batch.batchCode}を削除`}
                className="shrink-0 rounded border border-red-300 px-3 py-2 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {deleting === batch.id ? "削除中…" : "削除"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between">
        {hasCursor ? (
          <Link href="/inventory/photo-registration" className="text-xs text-gray-500 underline hover:text-gray-800">
            先頭に戻る
          </Link>
        ) : (
          <span />
        )}
        {nextCursor ? (
          <Link
            href={`/inventory/photo-registration?cursor=${encodeURIComponent(nextCursor)}`}
            className="inline-flex min-h-8 items-center rounded border border-gray-300 px-3 text-xs text-gray-700 hover:bg-gray-50"
          >
            次のページ
          </Link>
        ) : null}
      </div>
    </div>
  );
}
