import { ALL_EXTENDED_FIELDS } from "./extendedFields";
import { valuesEqual } from "./zaicoUpdatePolicy";

export const HUMAN_EDITED_FIELDS = "__belloEditedFields";
const fields = new Set(["name", "categoryId", "categoryIds", "locationId", "quantity", "unit", "note", "barcode", "purchasePrice", "salePrice", ...ALL_EXTENDED_FIELDS.map(field => field.key)]);
export const internalInventoryField = (key: string) => key.startsWith("__bello") || key === "__restageImport" || key === "__yahooPurchaseImport";
const internal = internalInventoryField;
export function productCustomFields(custom: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(custom ?? {}).filter(([key]) => !internal(key)));
}
export function humanEditedFields(custom: Record<string, unknown> | null | undefined): Set<string> {
  const stored = custom?.[HUMAN_EDITED_FIELDS];
  return new Set(Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string" && (fields.has(key) || key.startsWith("customFields.") && !internal(key.slice(13)))) : []);
}

/** Mark actual human changes in the same conditional update. Existing rows receive no retroactive flags. */
export function withHumanEdits(before: Record<string, unknown>, changes: Record<string, unknown>, beforeCustom: Record<string, unknown> | null,
  submittedCustom: Record<string, unknown> | undefined): Record<string, unknown> {
  const previous = beforeCustom ?? {};
  const next = { ...submittedCustom };
  // Internal metadata is not an editable product field. Web forms may omit it.
  for (const key of Object.keys(previous).filter(internal)) if (!(key in next)) next[key] = previous[key];
  const edited = humanEditedFields(previous);
  delete next[HUMAN_EDITED_FIELDS];
  for (const key of fields) if (changes[key] !== undefined && !valuesEqual(before[key], changes[key])) edited.add(key);
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (!internal(key) && !valuesEqual(previous[key], next[key])) edited.add(`customFields.${key}`);
  }
  if (edited.size || HUMAN_EDITED_FIELDS in previous) next[HUMAN_EDITED_FIELDS] = [...edited].sort();
  return next;
}
