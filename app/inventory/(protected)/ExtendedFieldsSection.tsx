"use client";

import type { ReactNode } from "react";
import type { ExtendedSectionDef } from "@/lib/inventory/extendedFields";
import type { FieldSize } from "./FormFields";
import { DateField } from "../DateField";

interface ExtendedFieldsSectionProps {
  section: ExtendedSectionDef;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /**
   * Extra, non-generic field(s) to render first inside this section's
   * grid — used only for 仕入・古物台帳 to place the existing
   * purchasePrice/salePrice inputs there (spec: purchasePrice IS that
   * ledger's「購入価格」, not a duplicate field). Those two have their
   * own dedicated state in NewInventoryForm/EditInventoryForm already
   * (unchanged from before Phase C), so this is the one place the
   * "everything comes from the shared config" rule bends slightly rather
   * than the whole section-selection logic being copy-pasted into both
   * forms.
   */
  extra?: ReactNode;
  /**
   * BELLO統合改修 master指示書 Phase C — both default to the exact
   * pre-Phase-C look (2-column grid, 13px compact inputs), so
   * NewInventoryForm.tsx (which never passes these) is completely
   * unaffected. Only EditInventoryForm.tsx passes size="large"
   * columns={1} (spec: 編集画面の追加項目セクションも単一カラム).
   */
  size?: FieldSize;
  columns?: 1 | 2;
}

/**
 * Renders one Phase C section (販売情報 / サイズ・商品仕様 / コンディシ
 * ョン / 仕入・古物台帳 / 管理メモ) from lib/inventory/extendedFields.ts's
 * shared config — used identically by NewInventoryForm and
 * EditInventoryForm so ~30 fields are defined once, not twice (spec §5).
 * `<details>` gives every section a collapse affordance (spec §4: "画面
 * が長くなりすぎる場合は折りたたみ可能"), open by default so nothing is
 * hidden from a first-time user by default — 基本情報/画像 aren't
 * rendered by this component at all; they stay the existing hand-written
 * fields in each form (they need master-data-driven `<select>`s and the
 * image editor, not a plain text/number/date/select input).
 */
const SIZE_CLASSES: Record<FieldSize, string> = {
  compact: "text-[13px] py-1",
  large: "text-[16px] py-2.5",
};

export function ExtendedFieldsSection({ section, values, onChange, extra, size = "compact", columns = 2 }: ExtendedFieldsSectionProps) {
  const fieldClass = `mt-0.5 w-full border border-gray-300 px-2.5 focus:border-gray-500 focus:outline-none ${SIZE_CLASSES[size]}`;
  // A single-column layout has nothing to "span" — col-span-2 on a
  // grid-cols-1 grid is a harmless no-op, but omitting it entirely keeps
  // the DOM/class list honest about what's actually a 1-column layout.
  const spanFullWidthClass = columns === 2 ? "col-span-2" : undefined;

  return (
    <details open className="mt-4 border-t border-gray-100 pt-4">
      <summary className="cursor-pointer text-[11px] font-bold text-gray-400">{section.title}</summary>
      <div className={`mt-3 grid gap-4 ${columns === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
        {extra}
        {section.fields.map((field) => (
          <div key={field.key} className={field.fullWidth ? spanFullWidthClass : undefined}>
            <label className="block text-[12px] text-gray-600">{field.label}</label>
            {field.type === "textarea" ? (
              <textarea
                value={values[field.key] ?? ""}
                onChange={(e) => onChange(field.key, e.target.value)}
                rows={size === "large" ? 4 : 2}
                className={fieldClass}
              />
            ) : field.type === "select" ? (
              <select value={values[field.key] ?? ""} onChange={(e) => onChange(field.key, e.target.value)} className={`bg-white ${fieldClass}`}>
                {(field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : field.type === "date" ? (
              <DateField value={values[field.key] ?? ""} onChange={(v) => onChange(field.key, v)} className={fieldClass} />
            ) : (
              <input
                type={field.type === "number" ? "number" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) => onChange(field.key, e.target.value)}
                className={fieldClass}
              />
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
