"use client";

import type { ReactNode } from "react";
import type { ExtendedSectionDef } from "@/lib/inventory/extendedFields";

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
export function ExtendedFieldsSection({ section, values, onChange, extra }: ExtendedFieldsSectionProps) {
  return (
    <details open className="mt-4 border-t border-gray-100 pt-4">
      <summary className="cursor-pointer text-[11px] font-bold text-gray-400">{section.title}</summary>
      <div className="mt-3 grid grid-cols-2 gap-4">
        {extra}
        {section.fields.map((field) => (
          <div key={field.key} className={field.fullWidth ? "col-span-2" : undefined}>
            <label className="block text-[12px] text-gray-600">{field.label}</label>
            {field.type === "textarea" ? (
              <textarea
                value={values[field.key] ?? ""}
                onChange={(e) => onChange(field.key, e.target.value)}
                rows={2}
                className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
              />
            ) : field.type === "select" ? (
              <select
                value={values[field.key] ?? ""}
                onChange={(e) => onChange(field.key, e.target.value)}
                className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
              >
                {(field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) => onChange(field.key, e.target.value)}
                className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
              />
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
