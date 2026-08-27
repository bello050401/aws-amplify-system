import Link from "next/link";
import { notFound } from "next/navigation";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  getInventoryDetail,
  listCategories,
  listCustomFieldDefinitions,
  listLocations,
  listStatuses,
} from "@/lib/inventory/queries";
import { InventoryThumbnail } from "../../InventoryThumbnail";

function formatYen(value: number | null): string {
  return value === null ? "-" : value.toLocaleString("ja-JP");
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
}

export default async function InventoryDetailPage({ params }: { params: { id: string } }) {
  const role = await getInventoryRole();
  if (!role) return null;

  const [item, categories, locations, statuses, fieldDefs] = await Promise.all([
    getInventoryDetail(params.id),
    listCategories(),
    listLocations(),
    listStatuses(),
    listCustomFieldDefinitions(),
  ]);

  if (!item) notFound();

  const category = item.categoryId ? categories.find((c) => c.id === item.categoryId) : undefined;
  const location = item.locationId ? locations.find((l) => l.id === item.locationId) : undefined;
  const status = item.statusId ? statuses.find((s) => s.id === item.statusId) : undefined;
  const canEdit = role === "ADMIN" || role === "EDITOR";

  const customFieldEntries = Object.entries(item.customFields ?? {});
  const fieldLabelByKey = new Map(fieldDefs.map((f) => [f.fieldKey, f.label]));

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <Link href="/inventory" className="text-[12px] text-gray-500 hover:text-gray-900">
        ← 在庫一覧へ戻る
      </Link>

      <div className="mt-3 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            {status && (
              <span className="border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700">{status.label}</span>
            )}
            <span className="font-mono text-[13px] text-gray-500">{item.sku}</span>
          </div>
          <h1 className="mt-1 text-lg font-bold text-gray-900">{item.name}</h1>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled title="次のPhaseで実装予定" className="border border-gray-200 px-3 py-1.5 text-[12px] text-gray-300">
            編集
          </button>
          <button type="button" disabled title="次のPhaseで実装予定" className="border border-gray-200 px-3 py-1.5 text-[12px] text-gray-300">
            複製
          </button>
          <button
            type="button"
            disabled
            title="次のPhaseで実装予定"
            className="border border-gray-200 px-3 py-1.5 text-[12px] text-gray-300"
          >
            削除
          </button>
        </div>
      </div>
      {!canEdit && (
        <p className="mt-1 text-[11px] text-gray-400">VIEWER権限のため、編集・複製・削除は行えません。</p>
      )}

      <div className="mt-6 grid grid-cols-[240px_1fr] gap-8">
        <div>
          {item.images.length === 0 ? (
            <InventoryThumbnail storageKey={null} alt={item.name} />
          ) : (
            <div className="grid grid-cols-3 gap-1">
              {item.images.map((img, i) => (
                <div key={img.storageKey} className={i === 0 ? "col-span-3" : ""}>
                  <InventoryThumbnail storageKey={img.storageKey} alt={`${item.name} 画像${i + 1}`} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
          <Field label="数量">
            {item.quantity} {item.unit ?? ""}
          </Field>
          <Field label="カテゴリ">{category?.name ?? "-"}</Field>
          <Field label="保管場所">{location?.name ?? "-"}</Field>
          <Field label="仕入単価">{formatYen(item.purchasePrice)}</Field>
          <Field label="販売価格">{formatYen(item.salePrice)}</Field>
          <Field label="作成日時">{formatDateTime(item.createdAt)}</Field>
          <Field label="更新日時">{formatDateTime(item.updatedAt)}</Field>
          <Field label="作成者">{item.createdBy ?? "-"}</Field>
          <Field label="更新者">{item.updatedBy ?? "-"}</Field>
          <div className="col-span-2">
            <Field label="備考">
              <span className="whitespace-pre-wrap">{item.note || "-"}</span>
            </Field>
          </div>

          {customFieldEntries.length > 0 && (
            <div className="col-span-2 mt-2 border-t border-gray-100 pt-3">
              <p className="mb-2 text-[11px] font-bold text-gray-400">追加項目</p>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                {customFieldEntries.map(([key, value]) => (
                  <Field key={key} label={fieldLabelByKey.get(key) ?? key}>
                    {String(value ?? "-")}
                  </Field>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-8">
        <p className="mb-2 text-[11px] font-bold text-gray-400">変更履歴</p>
        {item.history.length === 0 ? (
          <p className="text-[12px] text-gray-400">変更履歴はまだありません。</p>
        ) : (
          <table className="w-full max-w-2xl border-collapse text-[12px]">
            <thead className="text-left text-gray-400">
              <tr className="border-b border-gray-200">
                <th className="py-1 pr-3 font-normal">日時</th>
                <th className="py-1 pr-3 font-normal">操作者</th>
                <th className="py-1 pr-3 font-normal">項目</th>
                <th className="py-1 pr-3 font-normal">変更前</th>
                <th className="py-1 font-normal">変更後</th>
              </tr>
            </thead>
            <tbody>
              {item.history.map((h) => (
                <tr key={h.id} className="border-b border-gray-100 text-gray-700">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDateTime(h.changedAt)}</td>
                  <td className="py-1 pr-3">{h.changedBy ?? "-"}</td>
                  <td className="py-1 pr-3">{h.fieldName}</td>
                  <td className="py-1 pr-3 text-gray-400">{h.oldValue ?? "-"}</td>
                  <td className="py-1">{h.newValue ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] text-gray-400">{label}</p>
      <p className="text-gray-900">{children}</p>
    </div>
  );
}
