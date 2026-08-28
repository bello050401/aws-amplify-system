"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateInventory, type ImageSlotInput } from "@/app/actions/inventory";
import { LabeledInput, LabeledSelect, CustomFieldInput } from "../../FormFields";
import { ImageEditor, imageEditorHasError, imageEditorHasUploading, type ImageEditorSlot } from "../../../ImageEditor";
import type { CustomFieldDefinitionRow, InventoryDetail, MasterOption, StatusOption } from "@/lib/inventory/queries";

interface EditInventoryFormProps {
  item: InventoryDetail;
  categories: MasterOption[];
  locations: MasterOption[];
  statuses: StatusOption[];
  customFieldDefs: CustomFieldDefinitionRow[];
}

/**
 * Same fields as NewInventoryForm, minus SKU (shown read-only — it's the
 * system-issued identifier, spec explicitly rules out editing it here).
 * Shares LabeledInput/LabeledSelect/CustomFieldInput and ImageEditor with
 * the registration form; see ImageEditor.tsx for why an edit's images
 * start as "existing" slots rather than "new"/"copy" ones — nothing here
 * re-uploads or copies an image the user just leaves alone.
 */
export function EditInventoryForm({ item, categories, locations, statuses, customFieldDefs }: EditInventoryFormProps) {
  const router = useRouter();
  const [name, setName] = useState(item.name);
  const [categoryId, setCategoryId] = useState(item.categoryId ?? "");
  const [statusId, setStatusId] = useState(item.statusId ?? "");
  const [locationId, setLocationId] = useState(item.locationId ?? "");
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [unit, setUnit] = useState(item.unit ?? "");
  const [purchasePrice, setPurchasePrice] = useState(item.purchasePrice != null ? String(item.purchasePrice) : "");
  const [salePrice, setSalePrice] = useState(item.salePrice != null ? String(item.salePrice) : "");
  const [note, setNote] = useState(item.note ?? "");
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(item.customFields ?? {}).map(([k, v]) => [k, String(v ?? "")])),
  );
  const [imageSlots, setImageSlots] = useState<ImageEditorSlot[]>(
    item.images.map((img) => ({ id: crypto.randomUUID(), kind: "existing" as const, storageKey: img.storageKey })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleCustomFieldChange(fieldKey: string, value: string) {
    setCustomFieldValues((prev) => ({ ...prev, [fieldKey]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError("商品名を入力してください。");
    if (imageEditorHasUploading(imageSlots)) return setError("画像のアップロード完了までお待ちください。");
    if (imageEditorHasError(imageSlots)) {
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

      const images: ImageSlotInput[] = imageSlots.map((slot, idx) =>
        slot.kind === "copy"
          ? { kind: "copy", sourceStorageKey: slot.sourceStorageKey, sortOrder: idx }
          : { kind: "uploaded", storageKey: slot.storageKey as string, sortOrder: idx },
      );

      await updateInventory(item.id, {
        name,
        categoryId: categoryId || undefined,
        statusId: statusId || undefined,
        locationId: locationId || undefined,
        quantity: quantity ? Number(quantity) : 0,
        unit: unit || undefined,
        purchasePrice: purchasePrice ? Number(purchasePrice) : undefined,
        salePrice: salePrice ? Number(salePrice) : undefined,
        note: note || undefined,
        images,
        customFields,
      });
      // updateInventory redirect()s on success — see NewInventoryForm's
      // identical comment for why normal execution never reaches past this.
    } catch (err) {
      if (err && typeof err === "object" && "digest" in err && String(err.digest).startsWith("NEXT_REDIRECT")) {
        throw err;
      }
      setError(err instanceof Error ? err.message : "更新に失敗しました。");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-base font-bold text-gray-900">在庫編集</h1>
        <button type="button" onClick={() => router.push(`/inventory/${item.id}`)} className="text-[12px] text-gray-500 hover:text-gray-900">
          詳細へ戻る
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[12px] text-gray-600">SKU</label>
          <p className="mt-0.5 border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[13px] text-gray-500">{item.sku}</p>
        </div>
        <LabeledInput label="商品名" required value={name} onChange={setName} />

        <LabeledSelect label="カテゴリ" value={categoryId} onChange={setCategoryId} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        <LabeledSelect label="保管場所" value={locationId} onChange={setLocationId} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
        <LabeledSelect label="ステータス" value={statusId} onChange={setStatusId} options={statuses.map((s) => ({ value: s.id, label: s.label }))} />

        <div className="grid grid-cols-2 gap-2">
          <LabeledInput label="数量" type="number" value={quantity} onChange={setQuantity} />
          <LabeledInput label="単位" value={unit} onChange={setUnit} placeholder="個" />
        </div>
        <LabeledInput label="仕入単価" type="number" value={purchasePrice} onChange={setPurchasePrice} placeholder="円" />
        <LabeledInput label="販売価格" type="number" value={salePrice} onChange={setSalePrice} placeholder="円" />

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

      <div className="mt-4 border-t border-gray-100 pt-4">
        <ImageEditor slots={imageSlots} onChange={setImageSlots} />
      </div>

      {error && <p className="mt-4 text-[13px] text-red-600">{error}</p>}

      <div className="mt-6 flex gap-2">
        <button
          type="submit"
          disabled={submitting || imageEditorHasUploading(imageSlots)}
          className="bg-gray-900 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
        >
          {submitting ? "保存中…" : "保存する"}
        </button>
        <button type="button" onClick={() => router.push(`/inventory/${item.id}`)} className="border border-gray-300 px-4 py-2 text-[13px] text-gray-700">
          キャンセル
        </button>
      </div>
    </form>
  );
}
