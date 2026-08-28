import type { ExtendedSectionDef } from "@/lib/inventory/extendedFields";

interface ExtendedFieldsSummaryProps {
  sections: ExtendedSectionDef[];
  record: Record<string, string | number | null>;
}

/**
 * Detail-page read-only view of Phase C's extended sections, driven by
 * the same lib/inventory/extendedFields.ts config the forms use — no
 * separate label list to keep in sync. Per spec §6: an entirely-empty
 * section is skipped altogether ("未入力項目を大量に表示して画面を埋め
 * ない"/"未入力は省略可能"), and within a shown section only the fields
 * that actually have a value render. A plain Server Component (no
 * "use client") — this is pure read-only formatting, nothing here needs
 * interactivity.
 */
export function ExtendedFieldsSummary({ sections, record }: ExtendedFieldsSummaryProps) {
  return (
    <>
      {sections.map((section) => {
        const entries = section.fields
          .map((field) => ({ field, value: record[field.key] }))
          .filter(({ value }) => value !== null && value !== undefined && value !== "");
        if (entries.length === 0) return null;

        return (
          <div key={section.id} className="mt-6 border-t border-gray-100 pt-4">
            <p className="mb-2 text-[11px] font-bold text-gray-400">{section.title}</p>
            <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              {entries.map(({ field, value }) => (
                <div key={field.key} className={field.fullWidth ? "col-span-2" : undefined}>
                  <p className="text-[11px] text-gray-400">{field.label}</p>
                  <p className="whitespace-pre-wrap text-gray-900">
                    {field.type === "number" && typeof value === "number" ? value.toLocaleString("ja-JP") : String(value)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
