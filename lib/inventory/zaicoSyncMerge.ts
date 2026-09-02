import {
  buildZaicoSnapshot,
  parseSnapshot,
  resolveCustomFields,
  resolveFieldUpdate,
  ruleFor,
  type UpdateDecision,
} from "./zaicoUpdatePolicy";

/**
 * ZAICO同期の「今回どの項目を書き込むか」を決める層。
 *
 * 純粋関数。DBに触らないので、実データの値をそのまま渡して回帰にかけられる。
 * 判定そのものは lib/inventory/zaicoUpdatePolicy.ts が持ち、ここは
 * 同期エンジンの入出力の形へ橋渡しするだけ。
 *
 * ── なぜ層を分けるのか ──────────────────────────────────────────
 *
 * zaicoSyncEngine.ts は「ZAICOを読む・SKUを採番する・画像をS3へ入れる・
 * 履歴を書く」まで面倒を見る大きな関数で、そこへ判定を直接書くと
 * テストのたびにAWSのモックが要る。判定だけを切り出しておけば、
 * 実際に起きた事故の値をそのまま入れて確かめられる。
 */

/** ZAICOが今回渡してきた、BELLOの列に対応する値。 */
export interface ZaicoProposedValues {
  /** ZAICOのカテゴリ名から解決したBELLOのカテゴリID。 */
  categoryId?: string | null;
  locationId?: string | null;
  name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  note?: string | null;
  barcode?: string | null;
  purchasePrice?: number | null;
  salePrice?: number | null;
  /** extendedFields(plannedSalePrice / width / height / ...)。 */
  extendedFields: Record<string, unknown>;
  /** customFields(packageSize / seatDimensions / ...)。 */
  customFields: Record<string, unknown>;
}

/** いまBELLOに入っている値。 */
export interface BelloCurrentValues {
  categoryId?: string | null;
  locationId?: string | null;
  name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  note?: string | null;
  barcode?: string | null;
  purchasePrice?: number | null;
  salePrice?: number | null;
  extendedFields: Record<string, unknown>;
  customFields: Record<string, unknown>;
}

export interface FieldConflict {
  field: string;
  label: string;
  belloValue: unknown;
  zaicoValue: unknown;
  reason: string;
}

export interface SkippedField {
  field: string;
  label: string;
  belloValue: unknown;
  zaicoValue: unknown;
  reason: string;
}

export interface MergeResult {
  /** 実際に書き込む値(トップレベルの列)。 */
  updates: Record<string, unknown>;
  /** 実際に書き込む extendedFields。 */
  extendedFields: Record<string, unknown>;
  /** 実際に書き込む customFields(既存とマージ済みの完成形)。 */
  customFields: Record<string, unknown>;
  /** 人が変更していたので据え置いた項目。 */
  skipped: SkippedField[];
  /** 自動判断しない項目の食い違い。人へ提示する。 */
  conflicts: FieldConflict[];
  /** 次回の3-way判定のために保存するスナップショット(JSON文字列)。 */
  nextSnapshotJson: string;
  /** 何か書き込む必要があるか。 */
  hasChanges: boolean;
}

/** トップレベル列として扱う項目。 */
const TOP_LEVEL_FIELDS = [
  "categoryId",
  "locationId",
  "name",
  "quantity",
  "unit",
  "note",
  "barcode",
  "purchasePrice",
  "salePrice",
] as const;

function labelOf(field: string): string {
  return ruleFor(field)?.label ?? field;
}

/**
 * 今回の同期で何を書き込むかを決める。
 *
 * スナップショットには **ZAICOが渡してきた値** を記録する。BELLOへ実際に
 * 書き込んだ値ではない —— そこを取り違えると、人が変更した項目が次回
 * 「前回値と同じ」に見えてしまい、2回目の同期で結局上書きされる。
 */
export function mergeZaicoUpdate(params: {
  zaico: ZaicoProposedValues;
  bello: BelloCurrentValues;
  /** Inventory.zaicoSnapshotJson の中身。未記録なら null。 */
  snapshotJson: string | null | undefined;
  isNewRecord: boolean;
}): MergeResult {
  const { zaico, bello, snapshotJson, isNewRecord } = params;
  const snapshot = parseSnapshot(snapshotJson);

  const updates: Record<string, unknown> = {};
  const extendedFields: Record<string, unknown> = {};
  const skipped: SkippedField[] = [];
  const conflicts: FieldConflict[] = [];

  const record = (field: string, decision: UpdateDecision, zaicoValue: unknown, belloValue: unknown, sink: Record<string, unknown>) => {
    if (decision.action === "APPLY") {
      sink[field] = decision.value;
      return;
    }
    if (decision.action === "CONFLICT") {
      conflicts.push({ field, label: labelOf(field), belloValue, zaicoValue, reason: decision.reason });
      return;
    }
    // KEEP。値が同じ / ZAICOが空 のときは「据え置いた」と報告する意味が
    // 無いので、実際に人の編集で守ったときだけ記録する。
    if (decision.reason.includes("人が変更") || decision.reason.includes("BELLO側に値がある") || decision.reason.includes("判断できない")) {
      skipped.push({ field, label: labelOf(field), belloValue, zaicoValue, reason: decision.reason });
    }
  };

  // ── トップレベルの列 ────────────────────────────────────────────
  for (const field of TOP_LEVEL_FIELDS) {
    const zaicoValue = zaico[field];
    if (zaicoValue === undefined) continue;
    const belloValue = bello[field];
    const decision = resolveFieldUpdate({
      field,
      zaicoValue,
      belloValue,
      lastZaicoValue: snapshot ? snapshot[field] : undefined,
      isNewRecord,
    });
    record(field, decision, zaicoValue, belloValue, updates);
  }

  // ── extendedFields ──────────────────────────────────────────────
  for (const [field, zaicoValue] of Object.entries(zaico.extendedFields)) {
    const belloValue = bello.extendedFields[field];
    const decision = resolveFieldUpdate({
      field,
      zaicoValue,
      belloValue,
      lastZaicoValue: snapshot ? snapshot[field] : undefined,
      isNewRecord,
    });
    record(field, decision, zaicoValue, belloValue, extendedFields);
  }

  // ── customFields(キー単位) ─────────────────────────────────────
  const cf = resolveCustomFields({
    zaico: zaico.customFields,
    bello: bello.customFields,
    lastZaico: snapshot ? (snapshot.__customFields as Record<string, unknown> | undefined) : undefined,
    isNewRecord,
  });
  for (const key of cf.keptDeleted) {
    skipped.push({
      field: `customFields.${key}`,
      label: `追加項目(${key})`,
      belloValue: undefined,
      zaicoValue: zaico.customFields[key],
      reason: "人が削除した項目をZAICOで復活させない。",
    });
  }
  for (const key of cf.keptModified) {
    skipped.push({
      field: `customFields.${key}`,
      label: `追加項目(${key})`,
      belloValue: bello.customFields[key],
      zaicoValue: zaico.customFields[key],
      reason: "人が書き換えた項目をZAICOで戻さない。",
    });
  }

  // ── 次回のためのスナップショット ────────────────────────────────
  //
  // ZAICOが「何と言ってきたか」を記録する。書き込んだかどうかは無関係。
  const snapshotSource: Record<string, unknown> = {};
  for (const field of TOP_LEVEL_FIELDS) {
    if (zaico[field] !== undefined) snapshotSource[field] = zaico[field];
  }
  for (const [k, v] of Object.entries(zaico.extendedFields)) snapshotSource[k] = v;
  const nextSnapshot = buildZaicoSnapshot(snapshotSource);
  // customFields は入れ子で持つ(トップレベルのキーと衝突させない)。
  nextSnapshot.__customFields = buildZaicoSnapshot(zaico.customFields);

  const customFieldsChanged = JSON.stringify(cf.merged) !== JSON.stringify(bello.customFields);
  const hasChanges =
    Object.keys(updates).length > 0 || Object.keys(extendedFields).length > 0 || customFieldsChanged;

  return {
    updates,
    extendedFields,
    customFields: cf.merged,
    skipped,
    conflicts,
    nextSnapshotJson: JSON.stringify(nextSnapshot),
    hasChanges,
  };
}
