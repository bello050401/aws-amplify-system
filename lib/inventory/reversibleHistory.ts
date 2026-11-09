import { ALL_EXTENDED_FIELDS } from "./extendedFields";
import { internalInventoryField } from "./humanEdits";
import { parseCustomFields } from "./customFieldsCodecCore";

type Row = Record<string, unknown>;
export type SavedValue = { present: false } | { present: true; value: unknown };
export type FieldDelta =
  | { field: string; kind: "value"; before: SavedValue; after: SavedValue }
  | {
      field: string;
      kind: "text";
      start: number;
      removed: string;
      added: string;
      beforeLength: number;
      afterLength: number;
    }
  | {
      field: "categoryIds";
      kind: "categories";
      removed: { id: string; index: number }[];
      added: { id: string; index: number }[];
    };
export interface EditHistoryEntry {
  id: string;
  operationId: string;
  actor: string;
  source: string;
  at: string;
  version: 1;
  changes: FieldDelta[];
  blockedReason?: string;
}
export interface EditHistoryState {
  version: 1;
  entries: EditHistoryEntry[];
  cursor: number;
}
export const EDITABLE_INVENTORY_FIELDS = new Set([
  "sku",
  "name",
  "categoryIds",
  "statusId",
  "locationId",
  "quantity",
  "unit",
  "purchasePrice",
  "salePrice",
  "note",
  "images",
  ...ALL_EXTENDED_FIELDS.map((f) => f.key),
]);
export const EMPTY_EDIT_HISTORY: EditHistoryState = {
  version: 1,
  entries: [],
  cursor: 0,
};
const copy = <T>(value: T): T => structuredClone(value);
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameValue(v, b[i]))
    );
  const ka = Object.keys(a),
    kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) => Object.hasOwn(b, k) && sameValue((a as Row)[k], (b as Row)[k]),
    )
  );
}
function saved(row: Row, key: string): SavedValue {
  return Object.hasOwn(row, key)
    ? { present: true, value: copy(row[key]) }
    : { present: false };
}
const imageMetadata = new Set([
  "thumbnailKey",
  "mediumKey",
  "originalHash",
  "sourceUrl",
]);
function imageIdentity(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((image) =>
        image && typeof image === "object"
          ? Object.fromEntries(
              Object.entries(image).filter(([key]) => !imageMetadata.has(key)),
            )
          : image,
      )
    : value;
}
export function readEditHistory(row: Row): EditHistoryState {
  let state = row.editHistory;
  if (typeof state === "string") state = JSON.parse(state);
  if (state === undefined || state === null) return copy(EMPTY_EDIT_HISTORY);
  const s = state as EditHistoryState;
  if (
    s.version !== 1 ||
    !Array.isArray(s.entries) ||
    s.entries.length > 2 ||
    !Number.isInteger(s.cursor) ||
    s.cursor < 0 ||
    s.cursor > s.entries.length
  )
    throw new Error("変更履歴の整合性を確認できません。保存を停止しました。");
  return copy(s);
}
function publicCustom(row: Row): Row {
  return Object.fromEntries(
    Object.entries(parseCustomFields(row.customFields) ?? {}).filter(
      ([key]) => !internalInventoryField(key),
    ),
  );
}
export function inventoryFieldValue(row: Row, field: string): SavedValue {
  return field.startsWith("customFields.")
    ? saved(publicCustom(row), field.slice(13))
    : saved(row, field);
}
export function inventoryDiff(before: Row, after: Row): FieldDelta[] {
  const changes: FieldDelta[] = [];
  for (const field of EDITABLE_INVENTORY_FIELDS) {
    const a = saved(before, field),
      b = saved(after, field);
    if (sameValue(a, b)) continue;
    if (
      field === "images" &&
      a.present &&
      b.present &&
      sameValue(imageIdentity(a.value), imageIdentity(b.value))
    )
      continue;
    if (
      field === "categoryIds" &&
      a.present &&
      b.present &&
      Array.isArray(a.value) &&
      Array.isArray(b.value)
    ) {
      const oldIds = a.value as string[],
        newIds = b.value as string[];
      // Positions make category order exactly reversible, including pure reorder.
      changes.push({
        field,
        kind: "categories",
        removed: oldIds.flatMap((id, index) =>
          newIds[index] === id ? [] : [{ id, index }],
        ),
        added: newIds.flatMap((id, index) =>
          oldIds[index] === id ? [] : [{ id, index }],
        ),
      });
    } else if (
      a.present &&
      b.present &&
      typeof a.value === "string" &&
      typeof b.value === "string"
    ) {
      let start = 0,
        end = 0;
      while (
        start < Math.min(a.value.length, b.value.length) &&
        a.value[start] === b.value[start]
      )
        start++;
      while (
        end < Math.min(a.value.length, b.value.length) - start &&
        a.value[a.value.length - 1 - end] === b.value[b.value.length - 1 - end]
      )
        end++;
      const delta: FieldDelta = {
        field,
        kind: "text",
        start,
        removed: a.value.slice(start, a.value.length - end),
        added: b.value.slice(start, b.value.length - end),
        beforeLength: a.value.length,
        afterLength: b.value.length,
      };
      const full: FieldDelta = { field, kind: "value", before: a, after: b };
      changes.push(
        JSON.stringify(delta).length < JSON.stringify(full).length
          ? delta
          : full,
      );
    } else changes.push({ field, kind: "value", before: a, after: b });
  }
  const ac = publicCustom(before),
    bc = publicCustom(after);
  for (const key of new Set([...Object.keys(ac), ...Object.keys(bc)])) {
    const a = saved(ac, key),
      b = saved(bc, key);
    if (!sameValue(a, b))
      changes.push({
        field: "customFields." + key,
        kind: "value",
        before: a,
        after: b,
      });
  }
  return changes;
}
export function applyInventoryDiff(
  current: Row,
  changes: readonly FieldDelta[],
  direction: "undo" | "redo",
): Row {
  const next = copy(current),
    custom = parseCustomFields(current.customFields) ?? {};
  let customChanged = false;
  for (const d of changes) {
    const reverse = direction === "undo";
    if (
      !EDITABLE_INVENTORY_FIELDS.has(d.field) &&
      !d.field.startsWith("customFields.")
    )
      throw new Error("復元できない項目が履歴に含まれています。");
    if (d.kind === "value") {
      const isCustom = d.field.startsWith("customFields."),
        key = isCustom ? d.field.slice(13) : d.field,
        target = isCustom ? custom : next;
      if (isCustom && internalInventoryField(key))
        throw new Error("内部情報は復元できません。");
      const expected = reverse ? d.after : d.before,
        value = reverse ? d.before : d.after;
      const actual = saved(target, key);
      if (
        !sameValue(actual, expected) &&
        !(
          key === "images" &&
          actual.present &&
          expected.present &&
          sameValue(imageIdentity(actual.value), imageIdentity(expected.value))
        )
      )
        throw new Error(
          "変更後に値が更新されています。最新の履歴を確認してください。",
        );
      if (value.present) {
        const prior = target[key];
        target[key] = copy(value.value);
        if (
          key === "images" &&
          Array.isArray(target[key]) &&
          Array.isArray(prior)
        )
          target[key] = (target[key] as Row[]).map((image) => {
            const matching = prior.find(
              (old) => old?.storageKey === image?.storageKey,
            );
            return matching
              ? {
                  ...image,
                  ...Object.fromEntries(
                    Object.entries(matching).filter(([k]) =>
                      imageMetadata.has(k),
                    ),
                  ),
                }
              : image;
          });
      } else delete target[key];
      customChanged ||= isCustom;
    } else if (d.kind === "text") {
      const text = next[d.field],
        remove = reverse ? d.added : d.removed,
        add = reverse ? d.removed : d.added,
        length = reverse ? d.afterLength : d.beforeLength;
      if (
        typeof text !== "string" ||
        text.length !== length ||
        text.slice(d.start, d.start + remove.length) !== remove
      )
        throw new Error(
          "文章が更新されています。最新の履歴を確認してください。",
        );
      next[d.field] =
        text.slice(0, d.start) + add + text.slice(d.start + remove.length);
    } else {
      const ids = next.categoryIds;
      if (!Array.isArray(ids))
        throw new Error("カテゴリ情報が更新されています。");
      for (const p of [...(reverse ? d.added : d.removed)].sort(
        (a, b) => b.index - a.index,
      )) {
        if (ids[p.index] !== p.id)
          throw new Error("カテゴリの順番が更新されています。");
        ids.splice(p.index, 1);
      }
      for (const p of [...(reverse ? d.removed : d.added)].sort(
        (a, b) => a.index - b.index,
      ))
        ids.splice(p.index, 0, p.id);
    }
  }
  if (customChanged)
    next.customFields =
      typeof current.customFields === "string"
        ? JSON.stringify(custom)
        : custom;
  // Compatibility projection is derived, never an independent category history.
  if (changes.some((d) => d.field === "categoryIds")) {
    const ids = next.categoryIds as string[] | undefined;
    if (ids?.length) next.categoryId = ids[0];
    else delete next.categoryId;
  }
  return next;
}
export function recordInventorySave(
  before: Row,
  after: Row,
  meta: Omit<EditHistoryEntry, "version" | "changes">,
) {
  const state = readEditHistory(before),
    changes = inventoryDiff(before, after);
  if (!changes.length) return { changed: false, row: after, state };
  const entries = [
    ...state.entries.slice(0, state.cursor),
    { ...meta, version: 1 as const, changes },
  ].slice(-2);
  const next: EditHistoryState = {
    version: 1,
    entries,
    cursor: entries.length,
  };
  return {
    changed: true,
    state: next,
    row: {
      ...after,
      editHistory: next,
      revision: Number(before.revision ?? 0) + 1,
    },
  };
}
export function moveInventoryHistory(
  current: Row,
  direction: "undo" | "redo",
  operationId?: string,
): {row:Row;state:EditHistoryState;entry:EditHistoryEntry} {
  const state = readEditHistory(current),
    index = direction === "undo" ? state.cursor - 1 : state.cursor;
  const entry = state.entries[index];
  if (!entry)
    throw new Error(
      direction === "undo"
        ? "戻せる履歴がありません。保持される履歴は直近2回です。"
        : "進める履歴がありません。",
    );
  if (entry.blockedReason) throw new Error(entry.blockedReason);
  if (operationId && entry.operationId !== operationId)
    throw new Error(
      "後続の変更があります。この一括操作まで履歴を飛び越えることはできません。",
    );
  const next = applyInventoryDiff(current, entry.changes, direction);
  state.cursor += direction === "undo" ? -1 : 1;
  return {
    row: {
      ...next,
      editHistory: state,
      revision: Number(current.revision ?? 0) + 1,
    },
    state,
    entry,
  };
}

/** Reconstruct at most two changed-field views on demand, never persist copies
 * of the full product for the history screen. Operational metadata is excluded. */
export function inventoryHistoryViews(current: Row) {
  const history = readEditHistory(current);
  let first = copy(current);
  for (let i = history.cursor - 1; i >= 0; i--)
    first = applyInventoryDiff(first, history.entries[i].changes, "undo");
  return history.entries.map((entry) => {
    const after = applyInventoryDiff(first, entry.changes, "redo");
    const fields = [...new Set(entry.changes.map((d) => d.field))];
    const changes = fields.map((field) => ({
      field,
      before: inventoryFieldValue(first, field),
      after: inventoryFieldValue(after, field),
    }));
    first = after;
    return { id: entry.id, changes };
  });
}
