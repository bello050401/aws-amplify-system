import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listUnregisteredPhotoBatchesAction } from "@/app/actions/photoRegistration";
import { InventoryHeader } from "../../InventoryHeader";
import { PhotoBatchListTable } from "./PhotoBatchListTable";

interface PhotoRegistrationListPageProps {
  searchParams: { cursor?: string };
}

/** 未登録バッチ一覧。代表写真は表示された行から各バッチの先頭画像だけ遅延取得する。 */
export default async function PhotoRegistrationListPage({ searchParams }: PhotoRegistrationListPageProps) {
  const role = await getInventoryRole();
  // (protected) layoutが未ログインを既にredirect済みなのでnullにはならないが、型を絞るため。
  if (!role) return null;

  const heading = <h1 className="text-sm font-bold text-gray-900">画像登録 — 未登録バッチ</h1>;

  if (role === "VIEWER") {
    return (
      <div className="flex h-full flex-col">
        <InventoryHeader role={role} center={heading} />
        <div className="p-6 text-sm text-gray-600">この機能を利用する権限がありません(ADMIN または EDITOR が必要です)。</div>
      </div>
    );
  }

  const cursor = searchParams.cursor ?? null;
  const result = await listUnregisteredPhotoBatchesAction(cursor, 20);

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={heading} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!result.ok ? (
          result.code === "NOT_CONFIGURED" ? (
            <div role="status" className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              {result.message}
            </div>
          ) : (
            <div role="alert" className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900">
              {result.message}
            </div>
          )
        ) : result.value.items.length === 0 && !cursor ? (
          <div className="p-8 text-center text-sm text-gray-500">未登録の撮影バッチはありません。</div>
        ) : (
          <PhotoBatchListTable batches={result.value.items} nextCursor={result.value.nextCursor} hasCursor={cursor !== null} />
        )}
      </div>
    </div>
  );
}
