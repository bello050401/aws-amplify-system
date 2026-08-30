"use client";

import { useEffect, useState } from "react";
import { listImageProcessingVersionsAction, reprocessAllImagesAction, reprocessImageAction, rollbackImageVersionAction, type ImageProcessingVersionSummary } from "@/app/actions/imageProcessing";
import { BULK_IMAGE_PROCESSING_ELIGIBLE_STATUSES } from "@/lib/imageProcessing/types";
import { useInventoryImageUrl } from "./useInventoryImageUrl";

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
 *
 * 【不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §12での追加】
 * 以前はこのパネル自体は既に存在していたが、(1) 商品全体を1回で
 * 加工開始する明確なボタンが無く、画像1枚ごとの小さな「再加工」
 * テキストリンクしか無かった(「カテゴリを『出品待ち』に変更しないと
 * 何も起きない」という誤解の直接の原因——実際には未加工画像でも
 * 「再加工」を押せば処理は始まるが、ラベルが「再加工」のままで
 * 分かりにくかった)、(2) 加工前/加工後を実際の画像で見比べる手段が
 * 無かった(状態ラベルの文字だけ)。この2点を追加する——
 * 加工ロジック自体(enqueueProcessingJob/idempotencyKey)は一切変更
 * しない。
 */
const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  UNPROCESSED: { label: "未加工", className: "text-gray-400" },
  QUEUED: { label: "加工待ち", className: "text-gray-500" },
  PROCESSING: { label: "加工中…", className: "text-blue-600" },
  READY: { label: "加工済", className: "text-emerald-700" },
  NEEDS_REVIEW: { label: "要確認", className: "text-amber-700" },
  FAILED: { label: "失敗", className: "text-red-600" },
  REPROCESSING: { label: "再加工中…", className: "text-blue-600" },
  DEAD_LETTER: { label: "失敗(リトライ上限)", className: "text-red-600" },
};

/** 処理中・待機中は二重実行防止のため個別/一括ボタンとも無効化する。 */
const BUSY_STATUSES = new Set(["QUEUED", "PROCESSING", "REPROCESSING"]);

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

/** ボタンの文言を状態に応じて出し分ける — 「未加工の画像に『再加工』と書いてある」という分かりにくさの直接の対処。exportは`scripts/verify-image-processing.ts`が純粋ロジックとして直接検証できるようにするため。 */
export function reprocessButtonLabel(status: string): string {
  if (status === "UNPROCESSED") return "加工する";
  if (status === "FAILED" || status === "DEAD_LETTER") return "再試行";
  if (status === "READY" || status === "NEEDS_REVIEW") return "再加工";
  return "加工する";
}

/** §12.5: 加工前/加工後を実際の画像で見比べる、原本を破壊しないside-by-side表示。トグルで開閉する(常時表示すると画像が多い商品で重くなるため)。 */
function BeforeAfterToggle({ originalKey, processedKey, label }: { originalKey: string; processedKey: string; label: string }) {
  const [open, setOpen] = useState(false);
  const { url: originalUrl } = useInventoryImageUrl(open ? originalKey : null);
  const { url: processedUrl } = useInventoryImageUrl(open ? processedKey : null);

  return (
    <div className="mt-1">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-gray-400 hover:text-gray-900">
        {open ? "閉じる" : "加工前/加工後を見る"}
      </button>
      {open && (
        <div className="mt-1 flex gap-2">
          <div>
            <p className="mb-0.5 text-[10px] text-gray-400">加工前（原本）</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- S3署名URL、InventoryThumbnail等と同じ理由 */}
            {originalUrl && <img src={originalUrl} alt={`${label} 加工前`} className="h-24 w-24 border border-gray-200 object-cover" />}
          </div>
          <div>
            <p className="mb-0.5 text-[10px] text-gray-400">加工後</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- 同上 */}
            {processedUrl && <img src={processedUrl} alt={`${label} 加工後`} className="h-24 w-24 border border-gray-200 object-cover" />}
          </div>
        </div>
      )}
    </div>
  );
}

export function ImageProcessingPanel({ inventoryId, images }: { inventoryId: string; images: ImagePanelRow[] }) {
  const [byKey, setByKey] = useState<Record<string, ImageProcessingVersionSummary[]> | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
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

  const statusOf = (img: ImagePanelRow) => currentStatus(byKey[img.storageKey] ?? []);
  const readyCount = images.filter((img) => statusOf(img) === "READY").length;
  const needsReviewCount = images.filter((img) => statusOf(img) === "NEEDS_REVIEW").length;
  const failedCount = images.filter((img) => ["FAILED", "DEAD_LETTER"].includes(statusOf(img))).length;
  const anyBusyGlobally = images.some((img) => BUSY_STATUSES.has(statusOf(img)));
  // 一括ボタンの対象: 未加工・失敗・要確認(まだ完了扱いではない)の画像のみ。
  // 既にREADYの画像を一括ボタンで巻き込むと「意図せず全部再加工」に
  // なってしまう(付録B「再加工で全画像を巻き込む処理」の禁止と同じ
  // 理由) — 個別の「再加工」ボタンはREADY画像も明示的に選べる。
  const bulkTargets = images.filter((img) => (BULK_IMAGE_PROCESSING_ELIGIBLE_STATUSES as readonly string[]).includes(statusOf(img)));

  async function handleBulkProcess() {
    setBulkBusy(true);
    setError(null);
    try {
      const result = await reprocessAllImagesAction(
        inventoryId,
        bulkTargets.map((img) => ({ storageKey: img.storageKey, originalHash: img.originalHash })),
      );
      if (result.skippedNoHashCount > 0) {
        // 以前はここで「originalHash未計算のため予約できません(画像を保存し
        // 直すと自己修復されます)」と出していたが、hash未計算はサーバー側の
        // ensureOriginalHashがその場で元画像から計算して予約まで続けるように
        // なったため、この分岐へ来るのは「元画像そのものがS3に無い」場合だけ。
        // 利用者に無関係な操作(保存し直し)を促す文言は残さない。
        setError(`${result.skippedNoHashCount}件の画像は元画像が見つからないため加工できませんでした。該当画像を登録し直してください。`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "画像加工の開始に失敗しました。");
    } finally {
      setBulkBusy(false);
    }
  }

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
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-bold text-gray-400">
          画像加工状況: {readyCount}/{images.length}加工完了
          {needsReviewCount > 0 && ` ・${needsReviewCount}件要確認`}
          {failedCount > 0 && ` ・${failedCount}件失敗`}
        </p>
        {/* §12.3: 商品詳細の画像エリア付近に設置する明確なボタン——
            カテゴリを変更しなくてもこれだけで処理を開始できる。 */}
        <button
          type="button"
          onClick={handleBulkProcess}
          disabled={bulkBusy || anyBusyGlobally || bulkTargets.length === 0}
          title={bulkTargets.length === 0 ? "加工待ちの画像はありません" : undefined}
          className="bg-gray-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40"
        >
          {bulkBusy || anyBusyGlobally ? "画像を加工中…" : "画像を自動加工"}
        </button>
      </div>
      {error && <p className="mb-1.5 text-[11px] text-red-600">{error}</p>}
      <ul className="space-y-1">
        {images.map((img, i) => {
          const versions = byKey[img.storageKey] ?? [];
          const status = currentStatus(versions);
          const meta = STATUS_LABELS[status] ?? { label: status, className: "text-gray-500" };
          const superseded = versions.filter((v) => v.status === "SUPERSEDED" || (!v.active && v.status === "READY"));
          const activeVersion = versions.find((v) => v.active);
          const processedKey = activeVersion?.webKey ?? activeVersion?.processedMasterKey ?? null;
          const isBusy = busyKey === img.storageKey || BUSY_STATUSES.has(status);
          return (
            <li key={img.storageKey} className="text-[11px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-gray-500">画像{i + 1}:</span>
                <span className={`font-bold ${meta.className}`}>{meta.label}</span>
                <button type="button" onClick={() => handleReprocess(img)} disabled={isBusy} className="text-gray-400 hover:text-gray-900 disabled:opacity-50">
                  {reprocessButtonLabel(status)}
                </button>
                {superseded.length > 0 && (
                  <button
                    type="button"
                    onClick={() => handleRollback(img, superseded[superseded.length - 1].id)}
                    disabled={isBusy}
                    className="text-gray-400 hover:text-gray-900 disabled:opacity-50"
                  >
                    直前版に戻す
                  </button>
                )}
              </div>
              {status === "READY" && processedKey && <BeforeAfterToggle originalKey={img.storageKey} processedKey={processedKey} label={`画像${i + 1}`} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
