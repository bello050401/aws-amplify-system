import type { ExtendedFieldDef, ExtendedSectionDef } from "@/lib/inventory/extendedFields";
import { DetailInfoTable, type DetailInfoRow } from "./DetailInfoTable";

/**
 * One field not part of the shared extendedFields registry, injected
 * into a specific section by id (purchasePrice/salePrice — see
 * extendedFields.ts's SALES_SECTION_ID/USED_GOODS_LEDGER_SECTION_ID
 * comment for why they need this rather than just being added to the
 * registry). `rawValue` alone decides "-" vs. rendered, and whether the
 * section counts as non-empty; `display`, when given, is what actually
 * renders instead of the raw value's default `String(...)` — the caller
 * (the detail page) passes its own formatYen(...) output through this so
 * these two money fields read exactly like every other price on the
 * page, not a bare number.
 */
export interface ExtraSectionField {
  label: string;
  rawValue: string | number | null;
  display?: React.ReactNode;
}

interface ExtendedFieldsSummaryProps {
  sections: ExtendedSectionDef[];
  record: Record<string, string | number | null>;
  /** Keyed by section id. */
  extra?: Partial<Record<string, ExtraSectionField[]>>;
}

function formatFieldValue(field: ExtendedFieldDef, value: string | number | null): React.ReactNode {
  if (value === null || value === undefined || value === "") return "-";
  if (field.type === "number" && typeof value === "number") return `${value.toLocaleString("ja-JP")}${field.unit ?? ""}`;
  if (field.type === "date" && typeof value === "string") return value.replace(/-/g, "/"); // AWSDate "YYYY-MM-DD" → "YYYY/MM/DD"; plain string replace, never Date-parsed, so this can never shift a day from a timezone conversion
  return String(value);
}

/**
 * Detail-page read-only view of Phase C's extended sections, driven by
 * the same lib/inventory/extendedFields.ts config the forms use — no
 * separate label list to keep in sync.
 *
 * Visibility (revised for the 全情報確認用・1列縦スクロール型 detail
 * page): EVERY section always renders, and EVERY field in it always
 * renders, blank ones as "-" — a record with nothing filled in for
 * 仕入・古物台帳 still shows that section's full row list, all dashes,
 * rather than the section vanishing. This is a deliberate behavior
 * change from this component's earlier Phase C.5 form (which skipped a
 * section that had zero values anywhere in it): the point of this screen
 * is "every field the New/Edit forms can save is visible here",
 * including "nothing entered yet" as its own legible answer, not an
 * absent section a viewer can't tell apart from "this record has no such
 * fields at all".
 */
export function ExtendedFieldsSummary({ sections, record, extra }: ExtendedFieldsSummaryProps) {
  return (
    <>
      {sections.map((section) => {
        const fieldRows: DetailInfoRow[] = section.fields.map((field) => ({
          label: field.label,
          value: formatFieldValue(field, record[field.key]),
        }));
        const extraRows: DetailInfoRow[] = (extra?.[section.id] ?? []).map((f) => ({
          label: f.label,
          value: f.rawValue === null || f.rawValue === "" ? "-" : (f.display ?? String(f.rawValue)),
        }));
        const rows = [...fieldRows, ...extraRows];

        return (
          <div key={section.id} className="mt-5 border-t border-gray-100 pt-3">
            <p className="mb-1.5 text-[11px] font-bold text-gray-400">{section.title}</p>
            <DetailInfoTable rows={rows} />
          </div>
        );
      })}
    </>
  );
}
