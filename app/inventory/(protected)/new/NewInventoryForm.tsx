"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createInventory, type ImageSlotInput } from "@/app/actions/inventory";
import { LabeledInput, LabeledSelect, CustomFieldInput } from "../FormFields";
import { ImageEditor, imageEditorHasError, imageEditorHasUploading, type ImageEditorSlot } from "../../ImageEditor";
import { ExtendedFieldsSection } from "../ExtendedFieldsSection";
import { INVENTORY_EXTENDED_SECTIONS, extendedValuesFromRecord, parseExtendedValues, type InventoryExtendedFields } from "@/lib/inventory/extendedFields";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import type { CustomFieldDefinitionRow, MasterOption, StatusOption } from "@/lib/inventory/queries";

interface DuplicateSource extends InventoryExtendedFields {
  sourceSku: string;
  name: string;
  categoryId?: string;
  statusId?: string;
  locationId?: string;
  quantity?: number;
  unit?: string;
  purchasePrice?: number;
  salePrice?: number;
  note?: string;
  barcode?: string | null;
  customFields?: Record<string, unknown>;
  normalImages: InventoryImageRecord[];
  damageImages: InventoryImageRecord[];
}

/** duplicateFrom's saved images (isPrimary already resolved server-side, see new/page.tsx) → this session's editable slot list. Shared by both the normal and damage seeding below. */
function slotsFromImages(images: InventoryImageRecord[]): ImageEditorSlot[] {
  return images.map((img) => ({ id: crypto.randomUUID(), kind: "copy" as const, sourceStorageKey: img.storageKey, isPrimary: img.isPrimary }));
}

/**
 * The inverse, at submit time: this session's slot list → the flat,
 * type-tagged payload createInventory expects. sortOrder is the slot's
 * position within ITS OWN list (normal and damage are numbered
 * independently — see amplify/data/resource.ts's InventoryImage
 * comment). isPrimary is forced false for damage images regardless of
 * the slot's own field — the damage ImageEditor's UI never offers a way
 * to set it, but this is the one place that would matter if it somehow
 * were, since a damage photo must never become the top image.
 */
function slotsToImageInputs(slots: ImageEditorSlot[], type: "NORMAL" | "DAMAGE"): ImageSlotInput[] {
  return slots.map((slot, idx) => {
    const isPrimary = type === "NORMAL" && slot.isPrimary;
    return slot.kind === "copy"
      ? { kind: "copy", sourceStorageKey: slot.sourceStorageKey, sortOrder: idx, type, isPrimary }
      : { kind: "uploaded", storageKey: slot.storageKey as string, sortOrder: idx, type, isPrimary };
  });
}

interface NewInventoryFormProps {
  categories: MasterOption[];
  locations: MasterOption[];
  statuses: StatusOption[];
  customFieldDefs: CustomFieldDefinitionRow[];
  duplicateFrom?: DuplicateSource;
}

/**
 * Multi-image upload (spec §6/§30) is delegated to the shared ImageEditor
 * (app/inventory/ImageEditor.tsx), rendered TWICE — once for 商品画像
 * (normal), once for 傷・汚れ写真 (damage) — as two fully independent
 * slot lists/states (Phase C.5 §3/§8: two clearly separate upload areas,
 * one shared component, not a second copy of it). Each list's own array
 * position is that group's sortOrder; the normal group additionally
 * tracks an explicit `isPrimary` per slot (spec §4's "トップ画像"),
 * decoupled from position — see ImageEditor.tsx's resolveTopSlot. Both
 * lists are flattened into one type-tagged array (slotsToImageInputs)
 * only at submit time, matching how amplify/data/resource.ts's
 * InventoryImage customType actually stores them.
 *
 * `duplicateFrom` (set by new/page.tsx from ?duplicateFrom=<id>) seeds
 * every field except SKU from the source record, per spec: SKU always
 * comes fresh from generateInventorySku on submit, same as any other
 * registration — never the source's. Its images (both groups, isPrimary
 * included) become "copy" slots, not "uploaded" ones, so submitting this
 * form copies them to brand-new S3 objects rather than pointing two
 * Inventory records at the same key.
 *
 * Phase C's ~30 extended fields (販売情報/サイズ・商品仕様/コンディシ
 * ョン/仕入・古物台帳/管理メモ) are NOT hand-written here one by one —
 * they're driven entirely by lib/inventory/extendedFields.ts's shared
 * config via ExtendedFieldsSection, the exact same component
 * EditInventoryForm uses, so the ~30 field definitions exist in exactly
 * one place (spec §5).
 */
export function NewInventoryForm({ categories, locations, statuses, customFieldDefs, duplicateFrom }: NewInventoryFormProps) {
  const router = useRouter();
  const [name, setName] = useState(duplicateFrom?.name ?? "");
  const [categoryId, setCategoryId] = useState(duplicateFrom?.categoryId ?? "");
  const [statusId, setStatusId] = useState(duplicateFrom?.statusId ?? "");
  const [locationId, setLocationId] = useState(duplicateFrom?.locationId ?? "");
  const [quantity, setQuantity] = useState(String(duplicateFrom?.quantity ?? 1));
  const [unit, setUnit] = useState(duplicateFrom?.unit ?? "");
  const [purchasePrice, setPurchasePrice] = useState(duplicateFrom?.purchasePrice != null ? String(duplicateFrom.purchasePrice) : "");
  const [salePrice, setSalePrice] = useState(duplicateFrom?.salePrice != null ? String(duplicateFrom.salePrice) : "");
  const [barcode, setBarcode] = useState(duplicateFrom?.barcode ?? "");
  const [note, setNote] = useState(duplicateFrom?.note ?? "");
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(duplicateFrom?.customFields ?? {}).map(([k, v]) => [k, String(v ?? "")])),
  );
  const [extendedValues, setExtendedValues] = useState<Record<string, string>>(extendedValuesFromRecord(duplicateFrom ?? {}));
  const [normalImageSlots, setNormalImageSlots] = useState<ImageEditorSlot[]>(slotsFromImages(duplicateFrom?.normalImages ?? []));
  const [damageImageSlots, setDamageImageSlots] = useState<ImageEditorSlot[]>(slotsFromImages(duplicateFrom?.damageImages ?? []));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleCustomFieldChange(fieldKey: string, value: string) {
    setCustomFieldValues((prev) => ({ ...prev, [fieldKey]: value }));
  }

  function handleExtendedFieldChange(key: string, value: string) {
    setExtendedValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError("商品名を入力してください。");
    if (imageEditorHasUploading(normalImageSlots) || imageEditorHasUploading(damageImageSlots)) {
      return setError("画像のアップロード完了までお待ちください。");
    }
    // A failed upload must not be silently dropped from the submission —
    // that previously let a registration "succeed" with zero images and
    // no clear signal why.
    if (imageEditorHasError(normalImageSlots) || imageEditorHasError(damageImageSlots)) {
      return setError("アップロードに失敗した画像があります。該当の画像を削除するか、再度選択し直してください。");
    }
    for (const def of customFieldDefs) {
      if (def.required && !customFieldValues[def.fieldKey]?.trim()) {
        return setError(`「${def.label}」は必須項目です。`);
      }
    }

    setSubmitting(true);
    try {
      const customFields: Record<string, unknown> = {};
      for (const def of customFieldDefs) {
        const raw = customFieldValues[def.fieldKey];
        if (raw === undefined || raw === "") continue;
        customFields[def.fieldKey] = def.fieldType === "NUMBER" ? Number(raw) : raw;
      }

      const images: ImageSlotInput[] = [...slotsToImageInputs(normalImageSlots, "NORMAL"), ...slotsToImageInputs(damageImageSlots, "DAMAGE")];

      await createInventory({
        name,
        categoryId: categoryId || undefined,
        statusId: statusId || undefined,
        locationId: locationId || undefined,
        quantity: quantity ? Number(quantity) : 0,
        unit: unit || undefined,
        purchasePrice: purchasePrice ? Number(purchasePrice) : undefined,
        salePrice: salePrice ? Number(salePrice) : undefined,
        barcode: barcode || undefined,
        note: note || undefined,
        images,
        customFields,
        ...parseExtendedValues(extendedValues),
      });
      // createInventory redirect()s on success — Next.js implements that
      // as a thrown control-flow signal, so normal execution never
      // actually reaches past the call above on the happy path.
    } catch (err) {
      // A Next.js redirect() rethrow has digest "NEXT_REDIRECT" and must
      // be allowed to keep propagating, not swallowed as a form error.
      if (err && typeof err === "object" && "digest" in err && String(err.digest).startsWith("NEXT_REDIRECT")) {
        throw err;
      }
      setError(err instanceof Error ? err.message : "登録に失敗しました。");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-base font-bold text-gray-900">新規在庫登録</h1>
        <button type="button" onClick={() => router.push("/inventory")} className="text-[12px] text-gray-500 hover:text-gray-900">
          在庫一覧へ戻る
        </button>
      </div>

      {duplicateFrom && (
        <p className="mb-4 border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-600">
          「{duplicateFrom.sourceSku} {duplicateFrom.name}」の内容を引き継いでいます。在庫IDは登録時に新しく発番されます。内容を確認・修正してから登録してください。
        </p>
      )}

      <p className="mb-2 text-[11px] font-bold text-gray-400">基本情報</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[12px] text-gray-600">在庫ID</label>
          <p className="mt-0.5 border border-gray-200 bg-gray-50 px-2 py-1 text-[13px] text-gray-400">
            登録時に自動採番されます(例: B000001)
          </p>
        </div>
        <LabeledInput label="物品名" required value={name} onChange={setName} />

        <LabeledSelect label="カテゴリ" value={categoryId} onChange={setCategoryId} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        <LabeledSelect label="保管場所" value={locationId} onChange={setLocationId} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
        <LabeledSelect label="状態" value={statusId} onChange={setStatusId} options={statuses.map((s) => ({ value: s.id, label: s.label }))} />

        <div className="grid grid-cols-2 gap-2">
          <LabeledInput label="数量" type="number" value={quantity} onChange={setQuantity} />
          <LabeledInput label="単位" value={unit} onChange={setUnit} placeholder="個" />
        </div>
        <LabeledInput label="QRコード・バーコード" value={barcode} onChange={setBarcode} />

        <div className="col-span-2">
          <label className="block text-[12px] text-gray-600">備考</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          />
        </div>
      </div>

      {customFieldDefs.length > 0 && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <p className="mb-2 text-[11px] font-bold text-gray-400">追加項目</p>
          <div className="grid grid-cols-2 gap-4">
            {customFieldDefs.map((def) => (
              <CustomFieldInput
                key={def.id}
                def={def}
                value={customFieldValues[def.fieldKey] ?? ""}
                onChange={(v) => handleCustomFieldChange(def.fieldKey, v)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Phase C.5: two clearly separate upload areas (spec §2/§3) — 商品
          画像 is what shows up in the list/detail top image and is the
          future candidate pool for 出品用/補正済み画像 (spec §7);
          傷・汚れ写真 is condition documentation only and can never
          become the top image (see ImageEditor's variant prop). */}
      <div className="mt-4 border-t border-gray-100 pt-4">
        <p className="mb-2 text-[11px] font-bold text-gray-400">商品画像</p>
        <ImageEditor slots={normalImageSlots} onChange={setNormalImageSlots} variant="normal" />
      </div>

      <div className="mt-4 border-t border-gray-100 pt-4">
        <p className="mb-2 text-[11px] font-bold text-gray-400">傷・汚れ写真</p>
        <ImageEditor slots={damageImageSlots} onChange={setDamageImageSlots} variant="damage" />
      </div>

      {/* Phase C: 販売情報 / サイズ・商品仕様 / コンディション / 仕入・
          古物台帳 / 管理メモ, driven entirely by lib/inventory/
          extendedFields.ts's shared config. 仕入単価(purchasePrice) and
          販売価格(salePrice) — pre-existing fields with their own state
          above — are injected into the 仕入・古物台帳 section via
          `extra`, per spec: purchasePrice IS that ledger's「購入価格」,
          not a duplicate field. See EditInventoryForm for the identical
          layout. */}
      {INVENTORY_EXTENDED_SECTIONS.map((section) => (
        <ExtendedFieldsSection
          key={section.id}
          section={section}
          values={extendedValues}
          onChange={handleExtendedFieldChange}
          extra={
            section.id === "usedGoodsLedger" ? (
              <>
                <LabeledInput label="購入価格" type="number" value={purchasePrice} onChange={setPurchasePrice} placeholder="円" />
                <LabeledInput label="販売価格（成約）" type="number" value={salePrice} onChange={setSalePrice} placeholder="円" />
              </>
            ) : undefined
          }
        />
      ))}

      {error && <p className="mt-4 text-[13px] text-red-600">{error}</p>}

      <div className="mt-6 flex gap-2">
        <button
          type="submit"
          disabled={submitting || imageEditorHasUploading(normalImageSlots) || imageEditorHasUploading(damageImageSlots)}
          className="bg-gray-900 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
        >
          {submitting ? "登録中…" : "登録する"}
        </button>
        <button type="button" onClick={() => router.push("/inventory")} className="border border-gray-300 px-4 py-2 text-[13px] text-gray-700">
          キャンセル
        </button>
      </div>
    </form>
  );
}
