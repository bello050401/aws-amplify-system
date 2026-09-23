"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deletePhotoAssetAction, restorePhotoAssetAction } from "@/app/actions/photoRegistration";
import type { PhotoActorRole } from "@/lib/photoRegistration/types";
import type { WebPhotoAssetView } from "@/lib/photoRegistration/webAdapter";

const STATUS_LABEL: Record<string, string> = {
  UPLOADING: "アップロード中",
  READY: "準備完了",
  FLAGGED: "要確認",
  DELETED: "削除済み",
  FAILED: "失敗",
};

export function PhotoAssetGrid({
  batchId,
  assets,
  actorRole,
}: {
  batchId: string;
  assets: WebPhotoAssetView[];
  actorRole: PhotoActorRole;
}) {
  const router = useRouter();
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const canDelete = actorRole === "STAFF" || actorRole === "ADMIN";
  const canRestore = actorRole === "ADMIN";

  const setPending = (id: string, pending: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  async function handleDelete(photoAssetId: string) {
    if (pendingIds.has(photoAssetId)) return; // 二重送信防止
    setPending(photoAssetId, true);
    setErrors((prev) => ({ ...prev, [photoAssetId]: "" }));
    const result = await deletePhotoAssetAction(batchId, photoAssetId);
    setPending(photoAssetId, false);
    if (!result.ok) {
      setErrors((prev) => ({ ...prev, [photoAssetId]: result.message }));
      return;
    }
    router.refresh();
  }

  async function handleRestore(photoAssetId: string) {
    if (pendingIds.has(photoAssetId)) return;
    setPending(photoAssetId, true);
    setErrors((prev) => ({ ...prev, [photoAssetId]: "" }));
    const result = await restorePhotoAssetAction(batchId, photoAssetId);
    setPending(photoAssetId, false);
    if (!result.ok) {
      setErrors((prev) => ({ ...prev, [photoAssetId]: result.message }));
      return;
    }
    router.refresh();
  }

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {assets.map((asset, index) => {
        const pending = pendingIds.has(asset.id);
        const error = errors[asset.id];
        return (
          <li key={asset.id} className="flex flex-col gap-1 rounded border border-gray-200 bg-white p-2">
            <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded bg-gray-100">
              {asset.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- 署名付きURLは短命かつ動的なので next/image の外部ドメイン許可対象にしない
                <img src={asset.thumbnailUrl} alt={`画像 ${asset.sequence + 1 || index + 1}`} className="h-full w-full object-contain" loading="lazy" />
              ) : (
                <span className="text-xs text-gray-400">画像を表示できません</span>
              )}
              {asset.isDeleted ? (
                <span className="absolute left-1 top-1 rounded bg-gray-900/80 px-1.5 py-0.5 text-[10px] font-bold text-white">削除済み</span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-gray-600">
              #{asset.sequence + 1} ・ {STATUS_LABEL[asset.status] ?? asset.status} ・ {asset.sourceType === "WEB_UPLOAD" ? "Web" : "撮影機"}
            </p>
            {error ? (
              <p role="alert" className="text-[10px] text-red-600">
                {error}
              </p>
            ) : null}
            {!asset.isDeleted && canDelete ? (
              <button
                type="button"
                onClick={() => handleDelete(asset.id)}
                disabled={pending}
                aria-label={`画像 ${asset.sequence + 1} を削除`}
                className="min-h-7 rounded border border-red-300 px-2 text-[11px] text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "削除中…" : "削除"}
              </button>
            ) : null}
            {asset.isDeleted && canRestore ? (
              <button
                type="button"
                onClick={() => handleRestore(asset.id)}
                disabled={pending}
                aria-label={`画像 ${asset.sequence + 1} を復元`}
                className="min-h-7 rounded border border-blue-300 px-2 text-[11px] text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "復元中…" : "復元(ADMIN)"}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
