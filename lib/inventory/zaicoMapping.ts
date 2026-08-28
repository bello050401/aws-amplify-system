/**
 * Central ZAICO → BELLO field mapping (implementation instructions §5/§9:
 * "マッピングを1箇所に集約"). Every place that needs to know "what does
 * this ZAICO field become in BELLO" imports from here — lib/inventory/
 * zaicoSync.ts is the only caller, but the point of this file existing
 * separately is that it could never accidentally become two.
 *
 * Not `server-only`: pure data + pure functions, no Amplify/Data access
 * at all — safe to unit-test in isolation if that's ever added.
 *
 * ── Field mapping decisions, and why ──────────────────────────────────
 * Core fields (id/title/quantity/unit/category/place/etc/code/
 * item_image.url) are handled by `mapZaicoCoreFields` below — see its own
 * comment for the exact target of each.
 *
 * `state` is deliberately NOT mapped this pass: BELLO's closest
 * structural analog (StatusMaster) is a code+label master list, not a
 * free-text field, and the real sample showed `state: ""` (empty/unused)
 * — forcing a mapping for a field that may not even be populated was
 * judged premature. `created_at`/`updated_at` are also not persisted —
 * ZAICO's own updated_at isn't needed for diffing (this sync always
 * re-fetches full detail and compares field values directly, not
 * timestamps). Both are flagged in the completion report as open
 * questions rather than silently decided.
 *
 * `optional_attributes[].name` → target mapping is `ZAICO_ATTRIBUTE_MAP`
 * below, built ONLY from the exact names confirmed in the real sample
 * data — matched by exact normalized name, never by array position or
 * fuzzy/substring matching (explicit instruction: don't conflate
 * 販売価格/購入価格 or similarly-worded fields).
 */
import type { ExtendedFieldKey, InventoryExtendedFields } from "./extendedFields";
import type { ZaicoInventory, ZaicoOptionalAttribute } from "@/lib/zaico/client";

/**
 * NFKC (full/half-width unification) + variation-selector stripping +
 * wave-dash/tilde unification + trim + whitespace-collapse —
 * deliberately NOT lowercased and NOT stripped of bullet glyphs
 * (⚫︎/⚪︎/●/★ are meaningfully different markers in ZAICO's own field
 * naming convention, not noise to normalize away). This is intentionally
 * narrow: it fixes width/whitespace/presentation variants of the *same*
 * name, it does not and must not make two different-looking names
 * compare equal (NFKC never merges e.g. 販売価格/購入価格 — those share
 * no characters to begin with).
 *
 * Root cause fixed here (real-machine test against ZAICO ID 68875572):
 * NFKC decomposes FULLWIDTH PARENTHESIS （U+FF08）/）（U+FF09）to ASCII
 * "(" / ")" — so ZAICO's "⚪︎幅（cm）" normalizes to "⚪︎幅(cm)". That's
 * exactly right, but ZAICO_ATTRIBUTE_MAP's own keys below are plain
 * string literals, typed with the same fullwidth parens for
 * readability, and were never run through this function themselves — so
 * a normalized *input* was being compared against an un-normalized
 * *key*, and every field whose label contains parentheses (幅/奥行/高さ/
 * コンディション評価) silently failed to match. Fixed structurally, not
 * by hand-editing each key: NORMALIZED_ATTRIBUTE_MAP below builds its
 * lookup keys by running ZAICO_ATTRIBUTE_MAP's own keys through this
 * exact same function, so the two sides can never drift apart again —
 * for any future entry added to ZAICO_ATTRIBUTE_MAP, not just today's.
 *
 * Variation selectors (U+FE00–U+FE0F) select emoji vs. text presentation
 * for the character before them without changing its meaning — "⚪"
 * typed on different systems may or may not carry one (e.g. "⚪︎" vs
 * "⚪"), which would otherwise break an otherwise-identical match the
 * same way the parenthesis issue did. Wave dash (U+301C, common in
 * Japanese source text) and fullwidth tilde (U+FF5E) are visually
 * indistinguishable and both render as "〜"/"～" depending on
 * font/platform; NFKC only normalizes the latter to ASCII "~", so the
 * former is unified explicitly too.
 */
export function normalizeZaicoAttributeName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[︀-️]/g, "")
    .replace(/[〜～]/g, "~")
    .trim()
    .replace(/\s+/g, " ");
}

export type ZaicoValueType = "number" | "date" | "text";

export type ZaicoAttributeTarget =
  | { kind: "coreField"; field: "purchasePrice" | "salePrice"; valueType: "number" }
  | { kind: "extendedField"; field: ExtendedFieldKey; valueType: ZaicoValueType; createOnly?: boolean }
  | { kind: "customField"; fieldKey: string; valueType: ZaicoValueType }
  | { kind: "unmapped" };

/**
 * Exact-match table, keyed by `normalizeZaicoAttributeName(...)` of the
 * real `optional_attributes[].name` values confirmed in this phase.
 *
 * Four names were explicitly flagged by the spec as not having an
 * obvious existing-field match, resolved individually:
 * - "★市川メモ" → adminMemo, but `createOnly: true` — ZAICO's label
 *   matches BELLO's existing "管理メモ（市川メモ）" field exactly, but
 *   that field is BELLO staff's own free-edit note going forward; it's
 *   seeded from ZAICO once on first import and never overwritten by a
 *   later re-sync (deliberate deviation from every other mapped field's
 *   "ZAICO wins on every sync" rule — see zaicoSync.ts).
 * - "⚫︎相手氏名" → counterpartyName, ordinary ZAICO-authoritative
 *   mapping (仕入・古物台帳 already has this exact field).
 * - "●売却の優先度" → a new CustomFieldDefinition, `salePriority` (see
 *   customFieldSeed.ts) — none of BELLO's existing fields mean this.
 * - "●販売日数" → left unmapped (reported, not stored) — derivable from
 *   saleStartDate rather than needing its own storage; no existing field
 *   means the same thing.
 */
export const ZAICO_ATTRIBUTE_MAP: Record<string, ZaicoAttributeTarget> = {
  "⚫︎市場": { kind: "extendedField", field: "market", valueType: "text" },
  "⚫︎商品ID": { kind: "extendedField", field: "externalProductId", valueType: "text" },
  "⚫︎販売価格": { kind: "coreField", field: "salePrice", valueType: "number" },
  "⚫︎購入価格": { kind: "coreField", field: "purchasePrice", valueType: "number" },
  "⚫︎販売手数料": { kind: "extendedField", field: "saleCommission", valueType: "number" },
  "⚫︎販売終了日": { kind: "extendedField", field: "saleEndDate", valueType: "date" },
  "⚫︎販売開始日": { kind: "extendedField", field: "saleStartDate", valueType: "date" },
  "⚫︎取引の年月日": { kind: "extendedField", field: "transactionDate", valueType: "date" },
  "⚪︎幅（cm）": { kind: "extendedField", field: "width", valueType: "text" },
  "⚪︎奥行（cm）": { kind: "extendedField", field: "depth", valueType: "text" },
  "⚪︎高さ（cm）": { kind: "extendedField", field: "height", valueType: "text" },
  "⚪︎座面寸法": { kind: "customField", fieldKey: "seatDimensions", valueType: "text" },
  "⚪︎傷汚れ箇所等メモ": { kind: "extendedField", field: "damageNotes", valueType: "text" },
  // Only one wave-dash spelling needs to appear here now — normalizeZaicoAttributeName
  // unifies U+301C (〜) and U+FF5E (～) to the same "~" before either side
  // is ever compared (see NORMALIZED_ATTRIBUTE_MAP below), so a second
  // entry for the other spelling would be dead weight, not defense.
  "⚪︎コンディション評価(1〜5の5段階で)": { kind: "extendedField", field: "conditionRating", valueType: "text" },
  "★市川メモ": { kind: "extendedField", field: "adminMemo", valueType: "text", createOnly: true },
  "⚫︎相手氏名": { kind: "extendedField", field: "counterpartyName", valueType: "text" },
  "●売却の優先度": { kind: "customField", fieldKey: "salePriority", valueType: "text" },
  "●販売日数": { kind: "unmapped" },
};

/**
 * The actual lookup structure — keys run through normalizeZaicoAttributeName
 * exactly once, at module load, from ZAICO_ATTRIBUTE_MAP's own (human-
 * readable, un-normalized) keys above. This is what fixes the root cause
 * documented on normalizeZaicoAttributeName's own comment: comparing a
 * normalized *input* against un-normalized *keys* silently failed to
 * match any label containing full-width parentheses. Building this once,
 * structurally, means ZAICO_ATTRIBUTE_MAP can keep being typed with
 * natural full-width Japanese punctuation (readable, matches ZAICO's own
 * UI) without ever needing to be hand-normalized entry-by-entry, now or
 * for any future addition.
 */
const NORMALIZED_ATTRIBUTE_MAP: Map<string, ZaicoAttributeTarget> = new Map(
  Object.entries(ZAICO_ATTRIBUTE_MAP).map(([key, target]) => [normalizeZaicoAttributeName(key), target]),
);

/**
 * ZAICO section-heading decorations look like "<<出品情報>>" — a label
 * ZAICO's own UI renders as a group heading, not a real per-item field.
 * Silently ignored ONLY when it also carries no value: a heading is
 * never expected to have one, so an empty value is the signal this is
 * decoration, not data. If a name matching this shape ever DOES carry a
 * real value, it is deliberately NOT ignored — reported as unmapped like
 * any other unrecognized field, since at that point it might be real
 * data under an unexpected name (spec: 値を持つ未知項目まで一律ignore
 * しない).
 */
const DECORATIVE_HEADING_PATTERN = /^<<.*>>$/;

function isDecorativeHeading(name: string, value: string | null | undefined): boolean {
  return DECORATIVE_HEADING_PATTERN.test(normalizeZaicoAttributeName(name)) && !value?.trim();
}

export function resolveZaicoAttributeTarget(rawName: string): ZaicoAttributeTarget {
  const normalized = normalizeZaicoAttributeName(rawName);
  return NORMALIZED_ATTRIBUTE_MAP.get(normalized) ?? { kind: "unmapped" };
}

export interface ParsedValue<T> {
  value: T | null;
  warning?: string;
}

/** "22800", "22,800", " 48.5 " → a number; anything that doesn't parse is a warning, never a thrown error — one bad optional_attribute must never fail the whole item's sync. */
export function parseZaicoNumber(raw: string | null | undefined, label: string): ParsedValue<number> {
  const trimmed = raw?.trim();
  if (!trimmed) return { value: null };
  const cleaned = trimmed.replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    return { value: null, warning: `「${label}」の値 "${raw}" を数値に変換できませんでした。` };
  }
  return { value: n };
}

/** "2026/08/27", "2026-08-27" → "2026-08-27" (a.date()'s expected form). Anything else is a warning, value null — never thrown. */
export function parseZaicoDate(raw: string | null | undefined, label: string): ParsedValue<string> {
  const trimmed = raw?.trim();
  if (!trimmed) return { value: null };
  const normalized = trimmed.replace(/\//g, "-");
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (!match) {
    return { value: null, warning: `「${label}」の値 "${raw}" を日付に変換できませんでした。` };
  }
  const [, y, m, d] = match;
  return { value: `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` };
}

export interface ZaicoCoreMappedFields {
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  barcode: string | null;
  categoryName: string | null;
  locationName: string | null;
  imageSourceUrl: string | null;
}

/**
 * The 8 core (non-optional_attribute) fields, per the implementation
 * instructions' mapping table:
 *   id → sourceInventoryId (handled by the caller, not here — this
 *        function is about the fields that land on the Inventory record
 *        itself, sourceInventoryId is set once by zaicoSync.ts)
 *   title → name
 *   quantity → quantity
 *   unit → unit
 *   category → Category（名前で findOrCreateMasterEntryByName）
 *   place → Location（同上）
 *   etc → note（既存の主備考フィールド）
 *   code → barcode（外部管理コード）
 *   item_image.url → 画像取込元（ここでは URL を返すだけ、実際の
 *        ダウンロード/S3アップロードは zaicoSync.ts が行う）
 */
export function mapZaicoCoreFields(item: ZaicoInventory): { fields: ZaicoCoreMappedFields; warnings: string[] } {
  const warnings: string[] = [];
  const name = item.title?.trim();
  if (!name) warnings.push("titleが空のため、商品名を仮の値で登録しました。");

  return {
    fields: {
      name: name || `ZAICO在庫 #${item.id}`,
      quantity: typeof item.quantity === "number" ? item.quantity : null,
      unit: item.unit?.trim() || null,
      note: item.etc?.trim() || null,
      barcode: item.code?.trim() || null,
      categoryName: item.category?.trim() || null,
      locationName: item.place?.trim() || null,
      imageSourceUrl: item.item_image?.url?.trim() || null,
    },
    warnings,
  };
}

export interface MappedOptionalAttributes {
  /** Extended fields (lib/inventory/extendedFields.ts) to write — adminMemo included only when the caller passed isNewRecord: true, per its createOnly rule above. */
  extendedFields: Partial<InventoryExtendedFields>;
  /** purchasePrice/salePrice — core Inventory columns, not extendedFields. */
  coreFields: { purchasePrice?: number; salePrice?: number };
  /** CustomFieldDefinition values, keyed by fieldKey (seatDimensions/salePriority). */
  customFields: Record<string, string | number>;
  warnings: string[];
  /** optional_attributes whose name matched no known mapping — reported, never an error (spec §37). */
  unmapped: { name: string; value: string | null }[];
}

/**
 * `isNewRecord`: true only on first create for this ZAICO item — that's
 * the one and only moment "★市川メモ" is allowed to seed adminMemo (see
 * ZAICO_ATTRIBUTE_MAP's createOnly comment); every later re-sync of the
 * same item skips it, leaving whatever BELLO staff have since written
 * there untouched.
 */
export function mapZaicoOptionalAttributes(attrs: ZaicoOptionalAttribute[] | null | undefined, isNewRecord: boolean): MappedOptionalAttributes {
  const result: MappedOptionalAttributes = { extendedFields: {}, coreFields: {}, customFields: {}, warnings: [], unmapped: [] };
  for (const attr of attrs ?? []) {
    const target = resolveZaicoAttributeTarget(attr.name);
    if (target.kind === "unmapped") {
      // "<<出品情報>>"-shaped, no value ⇒ ZAICO's own section-heading
      // decoration, not real per-item data — silently skipped, no warning
      // (see isDecorativeHeading's own comment for why an empty value is
      // the deciding signal, not the name shape alone).
      if (isDecorativeHeading(attr.name, attr.value)) continue;
      result.unmapped.push({ name: attr.name, value: attr.value ?? null });
      continue;
    }
    if (target.kind === "extendedField" && target.createOnly && !isNewRecord) continue;

    let parsed: ParsedValue<number | string>;
    if (target.valueType === "number") parsed = parseZaicoNumber(attr.value, attr.name);
    else if (target.valueType === "date") parsed = parseZaicoDate(attr.value, attr.name);
    else parsed = { value: attr.value?.trim() || null };

    if (parsed.warning) result.warnings.push(parsed.warning);
    if (parsed.value === null) continue;

    if (target.kind === "coreField") {
      result.coreFields[target.field] = parsed.value as number;
    } else if (target.kind === "extendedField") {
      // Which of string/number `parsed.value` actually is was decided by
      // `target.valueType` above (and validated by parseZaicoNumber/
      // parseZaicoDate) — TS can't correlate that per-key at a dynamic
      // index into a union-typed object, so this one assignment is
      // deliberately untyped; ZAICO_ATTRIBUTE_MAP is the single place
      // that keeps each field's target type correct.
      (result.extendedFields as Record<string, unknown>)[target.field] = parsed.value;
    } else if (target.kind === "customField") {
      result.customFields[target.fieldKey] = parsed.value;
    }
  }
  return result;
}
