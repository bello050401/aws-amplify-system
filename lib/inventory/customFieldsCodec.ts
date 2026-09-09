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

/**
 * Tolerates a JSON string (what we always write), an already-parsed object
 * (observed on some reads), or a **double/triple-JSON-encoded string**
 * (observed on at least one existing record — a stray extra
 * `JSON.stringify` somewhere upstream/historical produced a string whose
 * parsed value is itself still a JSON string). Re-parses while the result
 * keeps coming back as a string, bounded so malformed data can't loop.
 *
 * Never throws; degrades to `null` on invalid JSON or on any non-object
 * result (e.g. a JSON array, or a plain non-JSON string) — callers spread
 * or `Object.entries()` this return value, and handing back a string or
 * array there is what produced the "0"/"1"/... character-indexed rows
 * reported for a double-encoded record (`Object.entries("...")` walks
 * characters). Matches parseFeatureContent's tolerant-degrade approach.
 *
 * ログには型・理由だけを出す(customFieldsは商品の追加項目という利用者
 * データそのものなので、生の値をログへ丸ごと吐かない。2026-09-10 再検収
 * 指示)。
 */
export function parseCustomFields(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw;
  let guard = 0;
  while (typeof value === "string" && guard < 5) {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      console.error("[Inventory.customFields] failed to JSON.parse stored value", {
        rawType: typeof raw,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    guard++;
  }
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    console.error("[Inventory.customFields] stored value is not an object after decoding", {
      rawType: typeof raw,
      decodedType: Array.isArray(value) ? "array" : typeof value,
    });
    return null;
  }
  return value as Record<string, unknown>;
}
