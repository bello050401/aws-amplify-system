"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { uploadData, remove } from "aws-amplify/storage";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { createInventory } from "@/app/actions/inventory";
import type { CustomFieldDefinitionRow, MasterOption, StatusOption } from "@/lib/inventory/queries";

interface NewInventoryFormProps {
  categories: MasterOption[];
  locations: MasterOption[];
  statuses: StatusOption[];
  customFieldDefs: CustomFieldDefinitionRow[];
}

interface ImageSlot {
  key: string; // client-side stable key (crypto.randomUUID), not the Storage path
  previewUrl: string;
  storageKey: string | null; // set once the upload finishes
  uploading: boolean;
  error: string | null;
}

/**
 * Multi-image upload (spec §6/§30): upload / preview / delete / set-main /
 * reorder. Images upload to S3 as soon as they're picked (not deferred to
 * form submit) so a slow or failed upload is visible immediately instead
 * of surfacing as one opaque failure at the very end. Order in `images`
 * IS the sortOrder — index 0 is the main image (matches
 * Inventory.images in amplify/data/resource.ts; no separate isMain flag).
 */
export function NewInventoryForm({ categories, locations, statuses, customFieldDefs }: NewInventoryFormProps) {
  const router = useRouter();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [statusId, setStatusId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [note, setNote] = useState("");
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>({});
  const [images, setImages] = useState<ImageSlot[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anyImageUploading = images.some((i) => i.uploading);

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);

    const newSlots: ImageSlot[] = files.map((file) => ({
      key: crypto.randomUUID(),
      previewUrl: URL.createObjectURL(file),
      storageKey: null,
      uploading: true,
      error: null,
    }));
    setImages((prev) => [...prev, ...newSlots]);

    await Promise.all(
      files.map(async (file, i) => {
        const slot = newSlots[i];
        const path = `inventory/${crypto.randomUUID()}-${file.name}`;
        try {
          await uploadData({ path, data: file }).result;
          setImages((prev) => prev.map((s) => (s.key === slot.key ? { ...s, storageKey: path, uploading: false } : s)));
        } catch (err) {
          setImages((prev) =>
            prev.map((s) =>
              s.key === slot.key
                ? { ...s, uploading: false, error: err instanceof Error ? err.message : "アップロードに失敗しました。" }
                : s,
            ),
          );
        }
      }),
    );
  }

  function removeImage(key: string) {
    const slot = images.find((s) => s.key === key);
    setImages((prev) => prev.filter((s) => s.key !== key));
    if (slot?.storageKey) {
      // Best-effort cleanup of the just-uploaded, now-unreferenced object.
      // Not awaited/blocking — a leftover orphaned file in S3 is a minor
      // cleanup concern, not something worth stalling the UI over.
      remove({ path: slot.storageKey }).catch(() => {});
    }
  }

  function moveImage(key: string, direction: -1 | 1) {
    setImages((prev) => {
      const index = prev.findIndex((s) => s.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function setAsMain(key: string) {
    setImages((prev) => {
      const index = prev.findIndex((s) => s.key === key);
      if (index <= 0) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.unshift(item);
      return next;
    });
  }

  function handleCustomFieldChange(fieldKey: string, value: string) {
    setCustomFieldValues((prev) => ({ ...prev, [fieldKey]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!sku.trim()) return setError("SKUを入力してください。");
    if (!name.trim()) return setError("商品名を入力してください。");
    if (anyImageUploading) return setError("画像のアップロード完了までお待ちください。");
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

      await createInventory({
        sku,
        name,
        categoryId: categoryId || undefined,
        statusId: statusId || undefined,
        locationId: locationId || undefined,
        quantity: quantity ? Number(quantity) : 0,
        unit: unit || undefined,
        purchasePrice: purchasePrice ? Number(purchasePrice) : undefined,
        salePrice: salePrice ? Number(salePrice) : undefined,
        note: note || undefined,
        images: images.filter((i) => i.storageKey).map((i, idx) => ({ storageKey: i.storageKey as string, sortOrder: idx })),
        customFields,
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
      <ConfigureAmplifyClientSide />
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-base font-bold text-gray-900">新規在庫登録</h1>
        <button type="button" onClick={() => router.push("/inventory")} className="text-[12px] text-gray-500 hover:text-gray-900">
          在庫一覧へ戻る
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <LabeledInput label="SKU" required value={sku} onChange={setSku} />
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
        <label className="block text-[12px] text-gray-600">画像（複数選択可・先頭が代表画像）</label>
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => handleFilesSelected(e.target.files)}
          className="mt-1 text-[12px]"
        />
        {images.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {images.map((img, index) => (
              <li key={img.key} className="w-24 border border-gray-200 p-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- local blob: object URL preview, not a remote asset next/image can optimize */}
                <img src={img.previewUrl} alt="" className="h-20 w-full object-cover" />
                {index === 0 && <p className="mt-0.5 text-center text-[10px] font-bold text-gray-700">メイン</p>}
                {img.uploading && <p className="text-center text-[10px] text-gray-400">アップロード中…</p>}
                {img.error && <p className="text-center text-[10px] text-red-600">{img.error}</p>}
                <div className="mt-1 flex justify-between text-[10px]">
                  <button type="button" onClick={() => moveImage(img.key, -1)} disabled={index === 0} className="disabled:text-gray-200">
                    ↑
                  </button>
                  {index !== 0 && (
                    <button type="button" onClick={() => setAsMain(img.key)} className="text-gray-500 hover:text-gray-900">
                      メインに
                    </button>
                  )}
                  <button type="button" onClick={() => moveImage(img.key, 1)} disabled={index === images.length - 1} className="disabled:text-gray-200">
                    ↓
                  </button>
                  <button type="button" onClick={() => removeImage(img.key)} className="text-red-500 hover:text-red-700">
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="mt-4 text-[13px] text-red-600">{error}</p>}

      <div className="mt-6 flex gap-2">
        <button
          type="submit"
          disabled={submitting || anyImageUploading}
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

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-[12px] text-gray-600">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
      />
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-[12px] text-gray-600">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
      >
        <option value="">未選択</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CustomFieldInput({
  def,
  value,
  onChange,
}: {
  def: CustomFieldDefinitionRow;
  value: string;
  onChange: (v: string) => void;
}) {
  const label = (
    <label className="block text-[12px] text-gray-600">
      {def.label}
      {def.required && <span className="text-red-500"> *</span>}
    </label>
  );

  if (def.fieldType === "TEXTAREA") {
    return (
      <div className="col-span-2">
        {label}
        <textarea
          value={value}
          required={def.required}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
        />
      </div>
    );
  }
  if (def.fieldType === "SELECT") {
    return (
      <div>
        {label}
        <select
          value={value}
          required={def.required}
          onChange={(e) => onChange(e.target.value)}
          className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
        >
          <option value="">未選択</option>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const inputType = def.fieldType === "NUMBER" ? "number" : def.fieldType === "DATE" ? "date" : def.fieldType === "URL" ? "url" : "text";
  return (
    <div>
      {label}
      <input
        type={inputType}
        value={value}
        required={def.required}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
      />
    </div>
  );
}
