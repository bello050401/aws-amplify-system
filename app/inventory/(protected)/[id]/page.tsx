import Link from "next/link";
import { notFound } from "next/navigation";
import { canEditInventory, canHardDeleteInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  getInventoryDetail,
  listCategories,
  listCustomFieldDefinitions,
  listLocations,
  listStatuses,
} from "@/lib/inventory/queries";
import { InventoryImageGallery } from "../../InventoryImageGallery";
import { DeleteInventoryButton } from "./DeleteInventoryButton";
import { ExtendedFieldsSummary } from "./ExtendedFieldsSummary";
import { ALL_EXTENDED_FIELDS, INVENTORY_EXTENDED_SECTIONS } from "@/lib/inventory/extendedFields";
import { resolveTopImage, splitImagesByType } from "@/lib/inventory/imageTypes";

function formatYen(value: number | null): string {
  return value === null ? "-" : value.toLocaleString("ja-JP");
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
}

export default async function InventoryDetailPage({ params }: { params: { id: string } }) {
  const role = await getInventoryRole();
  if (!role) return null;

  const item = await getInventoryDetail(params.id);
  if (!item) notFound();

  // Same reasoning as the edit page: a deactivated category/location must
  // still resolve to its name here rather than falling back to "-", since
  // this record still legitimately references it.
  const [categories, locations, statuses, fieldDefs] = await Promise.all([
    listCategories(item.categoryId),
    listLocations(item.locationId),
    listStatuses(),
    listCustomFieldDefinitions(),
  ]);

  const category = item.categoryId ? categories.find((c) => c.id === item.categoryId) : undefined;
  const location = item.locationId ? locations.find((l) => l.id === item.locationId) : undefined;
  const status = item.statusId ? statuses.find((s) => s.id === item.statusId) : undefined;
  const canEdit = canEditInventory(role);
  const canDelete = canHardDeleteInventory(role);

  const customFieldEntries = Object.entries(item.customFields ?? {});
  const fieldLabelByKey = new Map(fieldDefs.map((f) => [f.fieldKey, f.label]));
  // Phase C extended fields, projected down to the plain {key: value}
  // shape ExtendedFieldsSummary expects — built here rather than passing
  // `item` directly since InventoryDetail carries a lot more (images,
  // history, …) than just these ~30 fields.
  const extendedRecord = Object.fromEntries(ALL_EXTENDED_FIELDS.map((f) => [f.key, item[f.key]]));

  // Phase C.5: split once here rather than inside InventoryImageGallery,
  // which has no opinion on normal-vs-damage — it just renders whatever
  // array it's given. The resolved top image is moved to the front of
  // the normal group so the gallery's existing "first image is the big
  // one" behavior shows it, exactly like before an explicit isPrimary
  // existed (see resolveTopImage's own comment).
  const { normal: normalImages, damage: damageImages } = splitImagesByType(item.images);
  const topImage = resolveTopImage(item.images);
  const orderedNormalImages = topImage ? [topImage, ...normalImages.filter((i) => i.storageKey !== topImage.storageKey)] : normalImages;

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
        <div className="flex items-center gap-3">
          {canEdit && (
            <div className="flex gap-2">
              <Link href={`/inventory/${item.id}/edit`} className="border border-gray-300 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
                編集
              </Link>
              <Link href={`/inventory/new?duplicateFrom=${item.id}`} className="border border-gray-300 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
                複製
              </Link>
            </div>
          )}
          {/* Deliberately separated from 編集/複製, not styled the same way
              — spec asks for 削除 to be visually distinct so it isn't
              mistaken for "just another action button". See
              DeleteInventoryButton for the confirm-dialog gate itself. */}
          {canDelete && <DeleteInventoryButton inventoryId={item.id} label={`${item.sku} ${item.name}`} />}
        </div>
      </div>
      {role === "VIEWER" && <p className="mt-1 text-[11px] text-gray-400">VIEWER権限のため、編集・複製・削除は行えません。</p>}
      {role === "EDITOR" && <p className="mt-1 text-[11px] text-gray-400">削除はADMIN権限が必要です。</p>}

      <div className="mt-6 grid grid-cols-[420px_1fr] gap-8">
        <div>
          <InventoryImageGallery images={orderedNormalImages} alt={item.name} title="商品画像" />
          {/* hideIfEmpty: most items have zero damage photos — showing a
              big empty placeholder box for that common case would just
              be clutter (spec §6/§11). */}
          <div className="mt-6">
            <InventoryImageGallery images={damageImages} alt={`${item.name} 傷・汚れ`} title="傷・汚れ写真" hideIfEmpty />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
          <Field label="数量">
            {item.quantity} {item.unit ?? ""}
          </Field>
          <Field label="カテゴリ">{category?.name ?? "-"}</Field>
          <Field label="保管場所">{location?.name ?? "-"}</Field>
          <Field label="販売予定価格">{formatYen(item.plannedSalePrice)}</Field>
          <Field label="仕入単価">{formatYen(item.purchasePrice)}</Field>
          <Field label="販売価格（成約）">{formatYen(item.salePrice)}</Field>
          {item.barcode && <Field label="QRコード・バーコード">{item.barcode}</Field>}
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

      {/* Phase C: 販売情報 / サイズ・商品仕様 / コンディション / 仕入・
          古物台帳 / 管理メモ — only sections with at least one non-empty
          value render at all (spec §6). */}
      <ExtendedFieldsSummary sections={INVENTORY_EXTENDED_SECTIONS} record={extendedRecord} />

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
