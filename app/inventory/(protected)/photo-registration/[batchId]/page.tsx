import Link from "next/link";
import { notFound } from "next/navigation";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getPhotoBatchDetailAction } from "@/app/actions/photoRegistration";
import { InventoryHeader } from "../../../InventoryHeader";
import { PhotoAssetGrid } from "./PhotoAssetGrid";
import { WebUploadPanel } from "./WebUploadPanel";
import { InventoryLinkPanel } from "./InventoryLinkPanel";

const STATUS_LABEL: Record<string, string> = {
  CREATED: "作成済み(撮影中)",
  UPLOADING: "アップロード中",
  READY_FOR_REVIEW: "確認待ち",
  LINKED: "紐付け済み",
  ARCHIVED: "破棄",
  ERROR: "エラー",
};

const ASSET_PAGE_SIZE = 24;

interface PhotoBatchDetailPageProps {
  params: { batchId: string };
  searchParams: { assetPage?: string };
}

export default async function PhotoBatchDetailPage({ params, searchParams }: PhotoBatchDetailPageProps) {
  const role = await getInventoryRole();
  if (!role) return null;

  const heading = <h1 className="text-sm font-bold text-gray-900">画像登録 — バッチ詳細</h1>;

  if (role === "VIEWER") {
    return (
      <div className="flex h-full flex-col">
        <InventoryHeader role={role} center={heading} />
        <div className="p-6 text-sm text-gray-600">この機能を利用する権限がありません(ADMIN または EDITOR が必要です)。</div>
      </div>
    );
  }

  const assetPage = Math.max(1, Number(searchParams.assetPage) || 1);
  const result = await getPhotoBatchDetailAction(params.batchId, assetPage, ASSET_PAGE_SIZE);

  if (!result.ok && result.code === "BATCH_NOT_FOUND") notFound();

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader
        role={role}
        center={
          <div className="flex items-center gap-3">
            <Link href="/inventory/photo-registration" className="text-xs text-gray-500 underline hover:text-gray-800">
              ← 一覧へ戻る
            </Link>
            {heading}
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!result.ok ? (
          <div
            role={result.code === "NOT_CONFIGURED" ? "status" : "alert"}
            className={`rounded border p-4 text-sm ${
              result.code === "NOT_CONFIGURED" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-red-300 bg-red-50 text-red-900"
            }`}
          >
            {result.message}
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <section className="rounded border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-gray-900">{result.value.batch.batchCode}</p>
                  <p className="text-xs text-gray-500">
                    {STATUS_LABEL[result.value.batch.status] ?? result.value.batch.status} ・ 登録 {result.value.batch.manifest.registeredAssetCount}/
                    {result.value.batch.manifest.expectedAssetCount}枚 ・ 完了 {result.value.batch.manifest.completedAssetCount}枚
                    {result.value.batch.manifest.failedAssetCount > 0 ? ` ・ 失敗${result.value.batch.manifest.failedAssetCount}枚` : ""}
                  </p>
                </div>
                {result.value.batch.manifest.openRevision ? (
                  <span className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">
                    追加アップロード進行中(revision {result.value.batch.manifest.openRevision.revision})
                  </span>
                ) : null}
              </div>
            </section>

            <section>
              <h2 className="mb-2 text-xs font-bold text-gray-700">画像 ({result.value.totalAssetCount}枚)</h2>
              {result.value.totalAssetCount === 0 ? (
                <p className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">まだ画像がありません。</p>
              ) : (
                <>
                  <PhotoAssetGrid batchId={params.batchId} assets={result.value.assets} actorRole={result.value.actorRole} />
                  <PageLinks batchId={params.batchId} page={result.value.page} pageSize={result.value.pageSize} total={result.value.totalAssetCount} />
                </>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-xs font-bold text-gray-700">Webから画像を追加</h2>
              <WebUploadPanel batchId={params.batchId} batchStatus={result.value.batch.status} />
            </section>

            <section>
              <h2 className="mb-2 text-xs font-bold text-gray-700">在庫への紐付け</h2>
              <InventoryLinkPanel
                batchId={params.batchId}
                batchStatus={result.value.batch.status}
                currentInventoryId={result.value.batch.inventoryId}
                hasOpenRevision={result.value.batch.manifest.openRevision !== null}
              />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function PageLinks({ batchId, page, pageSize, total }: { batchId: string; page: number; pageSize: number; total: number }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="画像のページ" className="mt-3 flex items-center justify-center gap-3 text-xs text-gray-600">
      <Link
        aria-disabled={page <= 1}
        href={page <= 1 ? `/inventory/photo-registration/${batchId}` : `/inventory/photo-registration/${batchId}?assetPage=${page - 1}`}
        className={`rounded border border-gray-300 px-2 py-1 ${page <= 1 ? "pointer-events-none opacity-40" : "hover:bg-gray-50"}`}
      >
        前へ
      </Link>
      <span>
        {page} / {pageCount}
      </span>
      <Link
        aria-disabled={page >= pageCount}
        href={`/inventory/photo-registration/${batchId}?assetPage=${Math.min(page + 1, pageCount)}`}
        className={`rounded border border-gray-300 px-2 py-1 ${page >= pageCount ? "pointer-events-none opacity-40" : "hover:bg-gray-50"}`}
      >
        次へ
      </Link>
    </nav>
  );
}
