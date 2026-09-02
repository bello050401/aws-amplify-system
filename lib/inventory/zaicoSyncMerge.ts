import {
  buildZaicoSnapshot,
  parseSnapshot,
  resolveCustomFields,
  isEmptyValue,
  resolveFieldUpdate,
  ruleFor,
  shouldReportKeep,
  valuesEqual,
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

/**
 * 同期の走らせ方。
 *
 * ── なぜ2つ要るのか ─────────────────────────────────────────────
 *
 * 3-wayマージは「前回ZAICOが渡した値」を基準に、人が触ったかどうかを
 * 判定する。その基準(スナップショット)が**まだ1件も無い**。
 *
 * 基準が無い状態でいきなりマージを流すと、初回に食い違っていた項目は
 * すべて「人の編集か判断できない」として据え置かれ、その回にZAICOの値が
 * スナップショットへ入る。すると2回目以降は「BELLOの値 ≠ 前回ZAICO値」
 * となり、**それが人の編集だったかどうかに関わらず永久に据え置かれて
 * 毎回警告が出る**。
 *
 * そこで初回だけ SNAPSHOT_ONLY で走らせる。業務値には一切触れず、
 * ZAICOの現在値を基準として記録するだけ。同時に「その時点で食い違って
 * いた項目」を一覧で出すので、人はそれを見て判断できる。
 * 2回目からは MERGE で、本来の意味の3-wayが働く。
 */
export type MergeMode =
  /** 通常。方針表に従って書き込む。 */
  | "MERGE"
  /** 初回の基準作り。**業務値は1つも書き換えない。** */
  | "SNAPSHOT_ONLY";

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
  /** どのモードで判定したか。 */
  mode: MergeMode;
  /**
   * この結果が業務値(在庫の中身)を書き換えるか。
   * SNAPSHOT_ONLY では**必ず false**。呼び出し側がこれを見て、
   * 誤って業務値を書かないための最後の歯止めにできる。
   */
  writesBusinessValues: boolean;
  /**
   * SNAPSHOT_ONLY のときだけ埋まる ——「基準を作った時点で
   * ZAICOとBELLOが食い違っていた項目」。
   *
   * 据え置いた(skipped)でも食い違い(conflicts)でもない。まだ何も
   * 判定していない、人が見て決めるための一覧。
   */
  baselineDifferences: FieldConflict[];
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

/** 項目キーを人が読むラベルへ。履歴の記録でも同じ名前を使うため公開している。 */
export function labelOf(field: string): string {
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
  /** 省略時は "MERGE"。既存の呼び出しは何も変わらない。 */
  mode?: MergeMode;
}): MergeResult {
  const { zaico, bello, snapshotJson, isNewRecord } = params;
  const mode: MergeMode = params.mode ?? "MERGE";
  const snapshot = parseSnapshot(snapshotJson);

  // 初回の基準作り。業務値には触れず、いま食い違っているものを並べて返す。
  if (mode === "SNAPSHOT_ONLY") return buildBaseline({ zaico, bello, snapshotJson });

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
    // 無いので、実際に人の編集などで守ったときだけ記録する。
    //
    // 判定は理由の**種別**で行う。以前はここで理由の日本語文を
    // includes() で見ていたが、文面を直した瞬間に分類が静かに外れて
    // 「守ったのに報告されない」状態になりうる。
    if (shouldReportKeep(decision.kind)) {
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
    mode: "MERGE",
    writesBusinessValues: true,
    baselineDifferences: [],
  };
}

/**
 * 初回の基準作り(C案)。
 *
 * ── 何をするか ──────────────────────────────────────────────────
 *
 *   ・業務値は**1つも**書き換えない(updates / extendedFields は空、
 *     customFields は BELLO の現在値をそのまま返す)
 *   ・ZAICOの現在値をスナップショットとして記録する
 *   ・その時点で食い違っていた項目を baselineDifferences に並べる
 *
 * ── なぜ「据え置いた」と呼ばないか ──────────────────────────────
 *
 * 据え置き(skipped)は「人が編集したと判定したので守った」という意味。
 * ここではまだ何も判定していない —— 基準が無いので判定しようがない。
 * 意味の違うものを同じ名前で返すと、警告の意味が薄まって読まれなくなる。
 */
function buildBaseline(params: {
  zaico: ZaicoProposedValues;
  bello: BelloCurrentValues;
  snapshotJson: string | null | undefined;
}): MergeResult {
  const { zaico, bello, snapshotJson } = params;
  const baselineDifferences: FieldConflict[] = [];

  const note = (field: string, zaicoValue: unknown, belloValue: unknown) => {
    // ZAICOが値を持っていない項目は比べない。基準としては記録するが、
    // 「食い違い」として人に見せる意味が無い。
    if (isEmptyValue(zaicoValue)) return;
    if (valuesEqual(zaicoValue, belloValue)) return;
    baselineDifferences.push({
      field,
      label: labelOf(field),
      belloValue,
      zaicoValue,
      reason: "基準作成時点でZAICOとBELLOの値が違いました。どちらを正とするか確認してください。",
    });
  };

  for (const field of TOP_LEVEL_FIELDS) {
    if (zaico[field] === undefined) continue;
    note(field, zaico[field], bello[field]);
  }
  for (const [field, zaicoValue] of Object.entries(zaico.extendedFields)) {
    note(field, zaicoValue, bello.extendedFields[field]);
  }
  for (const [key, zaicoValue] of Object.entries(zaico.customFields)) {
    note(`customFields.${key}`, zaicoValue, bello.customFields[key]);
  }

  const snapshotSource: Record<string, unknown> = {};
  for (const field of TOP_LEVEL_FIELDS) {
    if (zaico[field] !== undefined) snapshotSource[field] = zaico[field];
  }
  for (const [k, v] of Object.entries(zaico.extendedFields)) snapshotSource[k] = v;
  const nextSnapshot = buildZaicoSnapshot(snapshotSource);
  nextSnapshot.__customFields = buildZaicoSnapshot(zaico.customFields);
  const nextSnapshotJson = JSON.stringify(nextSnapshot);

  return {
    // ここが空であることが、この関数の存在理由そのもの。
    updates: {},
    extendedFields: {},
    customFields: bello.customFields,
    skipped: [],
    conflicts: [],
    nextSnapshotJson,
    // スナップショットが変わるときだけ書く。既に同じ基準が入っていれば
    // 2回流しても何も起きない。
    hasChanges: nextSnapshotJson !== (snapshotJson ?? null),
    mode: "SNAPSHOT_ONLY",
    writesBusinessValues: false,
    baselineDifferences,
  };
}
