import "server-only";

/**
 * `Inventory.customFields` is an `a.json()` (AWSJSON) field — same wire
 * quirk documented in lib/features/contentCodec.ts (stringifyFeatureContent):
 * a write must send an actual JSON string, not a raw JS object, or the
 * mutation fails with `Variable 'customFields' has an invalid value.`
 * Duplicated here rather than imported from contentCodec.ts because that
 * module is typed specifically for FeatureContent's fixed shape; Inventory's
 * custom fields are an open `{ [fieldKey: string]: string | number | null }`
 * bag defined by CustomFieldDefinition rows, not a fixed interface.
 */
export function stringifyCustomFields(fields: Record<string, unknown> | null | undefined): string | undefined {
  if (!fields || Object.keys(fields).length === 0) return undefined;
  return JSON.stringify(fields);
}

/** Tolerates a JSON string (what we always write) or an already-parsed object (observed on some reads), matching parseFeatureContent's approach — never throws, degrades to null. */
export function parseCustomFields(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      console.error("[Inventory.customFields] failed to JSON.parse stored value:", raw, err);
      return null;
    }
  }
  return raw as Record<string, unknown>;
}
