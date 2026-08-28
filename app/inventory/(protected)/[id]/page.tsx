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
import { ExtendedFieldsSummary, type ExtraSectionField } from "./ExtendedFieldsSummary";
import { DetailInfoTable, type DetailInfoRow } from "./DetailInfoTable";
import { ALL_EXTENDED_FIELDS, INVENTORY_EXTENDED_SECTIONS, SALES_SECTION_ID, USED_GOODS_LEDGER_SECTION_ID } from "@/lib/inventory/extendedFields";
import { resolveTopImage, splitImagesByType } from "@/lib/inventory/imageTypes";

/** "60000" → "60,000円" — every price on this page (spec §21: readable Japanese yen, not a bare number). */
function formatYen(value: number | null): string {
  return value === null ? "-" : `${value.toLocaleString("ja-JP")}円`;
}

/** ISO datetime → "2026/08/28 17:40" — exact zero-padded format (spec §20); Intl's dateStyle/timeStyle shorthand drops the leading zero on month/day/hour, which doesn't match. */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The history log (lib/inventory/history.ts) writes one row per changed
 * field, `fieldName` doing double duty as either an actual field label
 * ("商品名") or, for create/delete, the operation itself ("登録"/"削除")
 * — there's no separate stored "operation type" column. spec §18 wants
 * a ZAICO-style 日時/操作/作成者/変更内容 table, so these two helpers
 * derive that split from what's already stored rather than needing a
 * schema change: 登録/削除 rows show their own summary text as-is under
 * 変更内容 with 操作="登録"/"削除"; every other row is an 編集 with
 * 変更内容 = "フィールド名 旧→新", combining what were separate
 * 項目/変更前/変更後 columns into the one cell spec's own example shows
 * (e.g. "価格 60,000→55,000").
 */
function historyOperationLabel(fieldName: string): string {
  if (fieldName === "登録" || fieldName === "削除") return fieldName;
  return "編集";
}

function historyChangeSummary(h: { fieldName: string; oldValue: string | null; newValue: string | null }): string {
  if (h.fieldName === "登録" || h.fieldName === "削除") return h.newValue ?? h.oldValue ?? "-";
  return `${h.fieldName} ${h.oldValue ?? "-"} → ${h.newValue ?? "-"}`;
}

/**
 * "商品詳細画面 = 閲覧専用の編集画面" (spec §1): every field the New/
 * Edit forms can save must be readable here too, so this page's data
 * fetch mirrors those forms' — full InventoryDetail (all ~30 extended
 * fields, both image types with isPrimary, CustomFields) rather than a
 * trimmed-down projection.
 */
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

  // Phase C's ~30 extended fields, projected down to the plain
  // {key: value} shape ExtendedFieldsSummary expects — the exact same
  // registry (lib/inventory/extendedFields.ts) the New/Edit forms render
  // their inputs from, so a field can never exist in one place and not
  // the other (spec §15/§16's single-source-of-truth requirement).
  const extendedRecord = Object.fromEntries(ALL_EXTENDED_FIELDS.map((f) => [f.key, item[f.key]]));

  // purchasePrice/salePrice are pre-existing core Inventory fields, not
  // part of the extendedFields registry — injected into their
  // spec-mandated sections (仕入・古物台帳's「購入価格」, 販売情報's
  // 「販売価格（成約）」, kept distinct from plannedSalePrice's
  // 「販売予定価格」) via the same section-id keys the New/Edit forms
  // use for the identical placement — see extendedFields.ts's
  // SALES_SECTION_ID/USED_GOODS_LEDGER_SECTION_ID comment.
  const extendedExtra: Partial<Record<string, ExtraSectionField[]>> = {
    [SALES_SECTION_ID]: [{ label: "販売価格（成約）", rawValue: item.salePrice, display: formatYen(item.salePrice) }],
    [USED_GOODS_LEDGER_SECTION_ID]: [{ label: "購入価格", rawValue: item.purchasePrice, display: formatYen(item.purchasePrice) }],
  };

  // Phase C.5: split once here rather than inside InventoryImageGallery,
  // which has no opinion on normal-vs-damage — it just renders whatever
  // array it's given. The resolved top image is moved to the front of
  // the normal group so the gallery's existing "first image is the big
  // one" behavior shows it, exactly like before an explicit isPrimary
  // existed (see resolveTopImage's own comment).
  const { normal: normalImages, damage: damageImages } = splitImagesByType(item.images);
  const topImage = resolveTopImage(item.images);
  const orderedNormalImages = topImage ? [topImage, ...normalImages.filter((i) => i.storageKey !== topImage.storageKey)] : normalImages;

  // 基本情報 (spec §4/§12: always shown, in full, regardless of which
  // fields are empty) — 在庫ID/物品名/状態 also appear in the header
  // above for at-a-glance identification, but spec's ZAICO-style
  // reference table lists them again here too; 保管場所/作成日/更新日/
  // 作成者/更新者 are placed in the right column instead (spec §14/§19),
  // not duplicated here.
  const basicRows: DetailInfoRow[] = [
    { label: "在庫ID", value: item.sku },
    { label: "物品名", value: item.name },
    { label: "カテゴリ", value: category?.name ?? "-" },
    { label: "状態", value: status?.label ?? "-" },
    { label: "数量", value: String(item.quantity) },
    { label: "単位", value: item.unit ?? "-" },
    { label: "QRコード・バーコード", value: item.barcode ?? "-" },
    { label: "備考", value: item.note || "-" },
  ];

  const metaRows: DetailInfoRow[] = [
    { label: "作成日", value: formatDateTime(item.createdAt) },
    { label: "更新日", value: formatDateTime(item.updatedAt) },
    { label: "作成者", value: item.createdBy ?? "-" },
    { label: "更新者", value: item.updatedBy ?? "-" },
  ];

  const customFieldRows: DetailInfoRow[] = customFieldEntries.map(([key, value]) => ({
    label: fieldLabelByKey.get(key) ?? key,
    value: String(value ?? "-"),
  }));

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
        {/* spec §17: 編集/複製/削除 clearly placed near the top, close to
            the image/identity block above — 削除 stays visually distinct
            from 編集/複製 (unchanged from earlier phases). */}
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
          {canDelete && <DeleteInventoryButton inventoryId={item.id} label={`${item.sku} ${item.name}`} />}
        </div>
      </div>
      {role === "VIEWER" && <p className="mt-1 text-[11px] text-gray-400">VIEWER権限のため、編集・複製・削除は行えません。</p>}
      {role === "EDITOR" && <p className="mt-1 text-[11px] text-gray-400">削除はADMIN権限が必要です。</p>}

      {/* ZAICO-style 3-column layout (spec §14): 画像 / 情報一覧 / 保管場所
          ・メタ情報・履歴. Collapses to one column below `lg` (spec §26) —
          DOM order (image → center → right) is exactly the mobile stacking
          order spec asks for, so no separate mobile-only reordering is
          needed. */}
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[380px_1fr_280px]">
        <div>
          <InventoryImageGallery images={orderedNormalImages} alt={item.name} title="商品画像" />
          {/* hideIfEmpty: most items have zero damage photos — showing a
              big empty placeholder box for that common case would just
              be clutter (spec §6/§11). */}
          <div className="mt-6">
            <InventoryImageGallery images={damageImages} alt={`${item.name} 傷・汚れ`} title="傷・汚れ写真" hideIfEmpty />
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[11px] font-bold text-gray-400">基本情報</p>
          <DetailInfoTable rows={basicRows} />

          {/* 販売情報 / サイズ・商品仕様 / コンディション / 仕入・古物
              台帳 / 管理メモ — driven entirely by the shared field
              registry (spec §15/§16); only a section with at least one
              actual value anywhere in it (including purchasePrice/
              salePrice injected via `extra`) renders at all. */}
          <ExtendedFieldsSummary sections={INVENTORY_EXTENDED_SECTIONS} record={extendedRecord} extra={extendedExtra} />

          {customFieldRows.length > 0 && (
            <div className="mt-5 border-t border-gray-100 pt-3">
              <p className="mb-1.5 text-[11px] font-bold text-gray-400">追加項目</p>
              <DetailInfoTable rows={customFieldRows} />
            </div>
          )}
        </div>

        <div>
          {/* 保管場所 — kept visually prominent (spec §19), not just
              another row buried in 基本情報. */}
          <div className="border border-gray-200 bg-gray-50 px-3 py-2">
            <p className="text-[11px] text-gray-400">保管場所</p>
            <p className="mt-0.5 text-[14px] font-bold text-gray-900">{location?.name ?? "-"}</p>
          </div>

          <div className="mt-4">
            <DetailInfoTable rows={metaRows} />
          </div>

          <div className="mt-6">
            <p className="mb-1.5 text-[11px] font-bold text-gray-400">更新履歴</p>
            {item.history.length === 0 ? (
              <p className="text-[12px] text-gray-400">変更履歴はまだありません。</p>
            ) : (
              // A capped, independently-scrolling area (spec §18: a long
              // history must not push the page's main info out of easy
              // reach) rather than an unbounded table.
              <div className="max-h-[420px] overflow-y-auto border border-gray-100">
                <table className="w-full border-collapse text-[11px]">
                  <thead className="sticky top-0 bg-gray-50 text-left text-gray-400">
                    <tr className="border-b border-gray-200">
                      <th className="py-1 px-2 font-normal">日時</th>
                      <th className="py-1 px-2 font-normal">操作</th>
                      <th className="py-1 px-2 font-normal">作成者</th>
                      <th className="py-1 px-2 font-normal">変更内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.history.map((h) => (
                      <tr key={h.id} className="border-b border-gray-100 text-gray-700">
                        <td className="whitespace-nowrap py-1 px-2 align-top">{formatDateTime(h.changedAt)}</td>
                        <td className="py-1 px-2 align-top">{historyOperationLabel(h.fieldName)}</td>
                        <td className="py-1 px-2 align-top">{h.changedBy ?? "-"}</td>
                        <td className="py-1 px-2 align-top">{historyChangeSummary(h)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
