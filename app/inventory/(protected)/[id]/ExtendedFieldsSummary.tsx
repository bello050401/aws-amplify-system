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
 * Per-field visibility (spec §12, revised from this section's original
 * Phase C behavior): within a section that has AT LEAST ONE populated
 * value (registry field or `extra`), every field in that section renders
 * — an empty one shows "-", it is not hidden — matching how ZAICO's own
 * detail screen reads (a fixed set of rows, blanks shown as blanks, not
 * missing). Only a section where literally everything is empty is
 * skipped entirely, so this doesn't regress into a wall of "-" rows for
 * an Inventory record that has no 仕入・古物台帳 data at all, say.
 */
export function ExtendedFieldsSummary({ sections, record, extra }: ExtendedFieldsSummaryProps) {
  return (
    <>
      {sections.map((section) => {
        const fieldRows: (DetailInfoRow & { hasValue: boolean })[] = section.fields.map((field) => {
          const raw = record[field.key];
          return { label: field.label, value: formatFieldValue(field, raw), hasValue: raw !== null && raw !== undefined && raw !== "" };
        });
        const extraRows: (DetailInfoRow & { hasValue: boolean })[] = (extra?.[section.id] ?? []).map((f) => ({
          label: f.label,
          value: f.rawValue === null || f.rawValue === "" ? "-" : (f.display ?? String(f.rawValue)),
          hasValue: f.rawValue !== null && f.rawValue !== "",
        }));
        const rows = [...fieldRows, ...extraRows];
        if (!rows.some((r) => r.hasValue)) return null; // whole section is empty — skip it, per spec

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
