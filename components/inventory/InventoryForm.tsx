"use client";

import { useState } from "react";
import { itemFormSchema, type ItemFormValues } from "@/lib/validation/itemSchema";
import { CategoryPicker } from "@/components/common/CategoryPicker";
import { LocationPicker } from "@/components/common/LocationPicker";
import { NumberInput } from "@/components/common/NumberInput";
import { PriceInput } from "@/components/common/PriceInput";
import { DatePicker } from "@/components/common/DatePicker";
import { ImageUploader } from "@/components/common/ImageUploader";
import { BarcodeScanner } from "@/components/common/BarcodeScanner";
import { InlineSpinner } from "@/components/common/LoadingOverlay";
import { ScanIcon } from "@/components/icons";

/**
 * 在庫の新規登録・編集で共通利用するフォーム(指示書 §9, §16)。
 * create/editの両方でこの1つのコンポーネントとitemFormSchemaを使う
 * (重複したフォームを別実装しない)。
 */
export function InventoryForm({
  draftItemId,
  initialValues,
  thumbnailKey,
  imageKeys,
  onThumbnailChange,
  onImagesChange,
  onSubmit,
  submitting,
  submitLabel = "保存する",
}: {
  draftItemId: string;
  initialValues: ItemFormValues;
  thumbnailKey: string | null;
  imageKeys: string[];
  onThumbnailChange: (key: string | null) => void;
  onImagesChange: (keys: string[]) => void;
  onSubmit: (values: ItemFormValues) => void;
  submitting: boolean;
  submitLabel?: string;
}) {
  const [values, setValues] = useState<ItemFormValues>(initialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [scannerOpen, setScannerOpen] = useState(false);

  function set<K extends keyof ItemFormValues>(key: K, value: ItemFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = itemFormSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[String(issue.path[0])] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    onSubmit(parsed.data);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 px-4 pb-32 pt-4 md:px-0">
      <Section title="画像">
        <ImageUploader
          itemId={draftItemId}
          thumbnailKey={thumbnailKey}
          imageKeys={imageKeys}
          onThumbnailChange={onThumbnailChange}
          onImagesChange={onImagesChange}
        />
      </Section>

      <Section title="基本情報">
        <Field label="物品名" error={errors.name} required>
          <input
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            className="tap-target w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none focus:border-bello-500"
            placeholder="例: 3人掛けソファ"
          />
        </Field>

        <div className="flex gap-3">
          <div className="flex-1">
            <NumberInput label="数量" value={values.quantity} onChange={(v) => set("quantity", v ?? 0)} required />
          </div>
          <div className="w-28">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-bello-700">単位</span>
              <select
                value={values.unit}
                onChange={(e) => set("unit", e.target.value)}
                className="tap-target w-full rounded-2xl border border-bello-200 bg-white px-3 py-3 text-base outline-none"
              >
                {["個", "点", "台", "脚", "本", "セット"].map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <CategoryPicker value={values.categoryId} onChange={(v) => set("categoryId", v)} />
        <LocationPicker value={values.locationId} onChange={(v) => set("locationId", v)} />

        <Field label="状態">
          <input
            value={values.status ?? ""}
            onChange={(e) => set("status", e.target.value || null)}
            placeholder="例: 出品待ち / 販売中"
            className="tap-target w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none focus:border-bello-500"
          />
        </Field>

        <Field label="備考">
          <textarea
            value={values.notes ?? ""}
            onChange={(e) => set("notes", e.target.value || null)}
            rows={4}
            className="w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none focus:border-bello-500"
          />
        </Field>
      </Section>

      <Section title="QRコード・バーコード">
        <div className="flex gap-2">
          <input
            value={values.barcode ?? ""}
            onChange={(e) => set("barcode", e.target.value || null)}
            placeholder="未入力の場合は保存時に自動採番されます"
            className="tap-target flex-1 rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none focus:border-bello-500"
          />
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="tap-target flex items-center gap-1 rounded-2xl bg-bello-800 px-4 text-sm font-semibold text-white"
          >
            <ScanIcon className="h-5 w-5" />
            撮影
          </button>
        </div>
      </Section>

      <Section title="価格">
        <PriceInput label="☆販売予定価格(送料別記載)" value={values.plannedPrice} onChange={(v) => set("plannedPrice", v)} />
        <div className="grid grid-cols-3 gap-2">
          <PriceInput label="1回目値下げ(30日)" value={values.discountPrice30} onChange={(v) => set("discountPrice30", v)} />
          <PriceInput label="2回目値下げ(60日)" value={values.discountPrice60} onChange={(v) => set("discountPrice60", v)} />
          <PriceInput label="3回目値下げ(90日)" value={values.discountPrice90} onChange={(v) => set("discountPrice90", v)} />
        </div>
      </Section>

      <Section title="コンディション">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-bello-700">コンディション評価(1〜5)</span>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => set("condition", n)}
                className={`tap-target flex-1 rounded-xl border py-2 text-sm font-bold ${
                  values.condition === n ? "border-bello-800 bg-bello-800 text-white" : "border-bello-200 text-bello-500"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </label>
        <Field label="傷汚れ箇所等メモ">
          <textarea
            value={values.damageNotes ?? ""}
            onChange={(e) => set("damageNotes", e.target.value || null)}
            rows={3}
            className="w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none focus:border-bello-500"
          />
        </Field>
      </Section>

      <Section title="寸法(cm)">
        <div className="grid grid-cols-2 gap-3">
          <NumberInput label="幅" value={values.widthCm} onChange={(v) => set("widthCm", v)} suffix="cm" />
          <NumberInput label="奥行" value={values.depthCm} onChange={(v) => set("depthCm", v)} suffix="cm" />
          <NumberInput label="高さ" value={values.heightCm} onChange={(v) => set("heightCm", v)} suffix="cm" />
          <NumberInput label="全長" value={values.lengthCm} onChange={(v) => set("lengthCm", v)} suffix="cm" />
        </div>
      </Section>

      <Section title="その他項目">
        <Field label="家財区分">
          <input
            value={values.householdCategory ?? ""}
            onChange={(e) => set("householdCategory", e.target.value || null)}
            className="tap-target w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none"
          />
        </Field>
        <Field label="品目">
          <input
            value={values.itemType ?? ""}
            onChange={(e) => set("itemType", e.target.value || null)}
            className="tap-target w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none"
          />
        </Field>
        <DatePicker label="取引の年月日" value={values.transactionDate} onChange={(v) => set("transactionDate", v)} />
        <Field label="古物の特徴">
          <textarea
            value={values.antiqueFeature ?? ""}
            onChange={(e) => set("antiqueFeature", e.target.value || null)}
            rows={2}
            className="w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none"
          />
        </Field>
        <DatePicker label="棚卸日" value={values.stocktakeDate} onChange={(v) => set("stocktakeDate", v)} />
      </Section>

      <div className="pb-safe-nav fixed inset-x-0 bottom-0 z-30 border-t border-bello-100 bg-white px-4 py-3 md:static md:border-0 md:bg-transparent md:px-0">
        <button
          type="submit"
          disabled={submitting}
          className="tap-target flex w-full items-center justify-center gap-2 rounded-full bg-bello-800 py-3.5 text-base font-bold text-white disabled:opacity-60"
        >
          {submitting && <InlineSpinner />}
          {submitLabel}
        </button>
      </div>

      {scannerOpen && (
        <BarcodeScanner
          onDetected={(code) => {
            set("barcode", code);
            setScannerOpen(false);
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl bg-white p-4 shadow-card">
      <h2 className="text-sm font-bold text-bello-800">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  error,
  required,
  children,
}: {
  label: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-bello-700">
        {label}
        {required && <span className="ml-1 text-danger-500">*</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-xs text-danger-500">{error}</span>}
    </label>
  );
}
