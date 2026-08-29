/**
 * Phase C's ~40 new Inventory fields, minus the small handful of
 * CustomFieldDefinition entries (see customFieldSeed.ts) — everything
 * here is a real column on the Inventory model (amplify/data/resource.ts).
 *
 * Not `server-only`: this registry is imported by the client-side
 * New/Edit forms (to render inputs) AND the server-side detail page (to
 * decide what to display) AND the server actions (to parse submitted
 * values) — it carries no data access itself, just field/section
 * metadata, the same role lib/inventory/listColumns.ts plays for the
 * list table.
 *
 * Field keys are English camelCase, independent of their Japanese UI
 * label — this is deliberate (spec §13): a future CSV/ZAICO-import
 * mapping is "CSV header → this field name" directly, without a
 * separate label↔key translation table to keep in sync.
 *
 * Why these particular ~40 requested items split the way they did
 * between "real Inventory field" (here) and "CustomFieldDefinition"
 * (customFieldSeed.ts): anything with real search/filter/sort value,
 * anything already explicitly named in spec §9's "don't bury these in
 * CustomField" list, and the 仕入・古物台帳 ledger fields (a
 * compliance record that needs to stay reliably exportable) are all
 * real columns. The remaining handful — 口金/脚高/座面寸法/梱包サイズ/
 * 古物の特徴 — are lower-frequency furniture-spec/description detail
 * that spec §9 explicitly flagged as CustomField candidates.
 */
// Every property is `T | null` in addition to being optional — `null`
// is what a Server Action sends to explicitly CLEAR a field on an edit
// (see parseExtendedValues below and extendedFieldsInput in
// app/actions/inventory.ts); omitting the property entirely (undefined)
// is only ever how an unrelated caller (e.g. a future migration script)
// would say "leave this field alone".
export interface InventoryExtendedFields {
  barcode?: string | null;
  plannedSalePrice?: number | null;
  firstMarkdownPrice?: string | null;
  secondMarkdownPrice?: string | null;
  thirdMarkdownPrice?: string | null;
  saleStartDate?: string | null;
  saleEndDate?: string | null;
  market?: string | null;
  externalProductId?: string | null;
  saleCommission?: number | null;
  listingNotes?: string | null;
  conditionRating?: string | null;
  damageNotes?: string | null;
  width?: string | null;
  depth?: string | null;
  height?: string | null;
  overallLength?: string | null;
  lengthAdjustable?: string | null;
  mountType?: string | null;
  usedGoodsItemType?: string | null;
  transactionDate?: string | null;
  purchaseQuantity?: number | null;
  transactionType?: string | null;
  identityVerificationMethod?: string | null;
  counterpartyName?: string | null;
  counterpartyOccupation?: string | null;
  counterpartyAddress?: string | null;
  shippingCost?: number | null;
  dailyPurchaseTotal?: number | null;
  adminMemo?: string | null;
}

export type ExtendedFieldKey = keyof InventoryExtendedFields;

export type ExtendedFieldType = "text" | "textarea" | "number" | "date" | "select";

export interface ExtendedFieldDef {
  key: ExtendedFieldKey;
  label: string;
  type: ExtendedFieldType;
  /** Only meaningful for type "select". Kept short and explicit on purpose — spec explicitly says not to invent option lists for fields whose real choices aren't decided yet (mountType, transactionType, identityVerificationMethod, counterpartyOccupation all stay plain text for that reason, ready to become a `select` later with no data migration). */
  options?: { value: string; label: string }[];
  fullWidth?: boolean;
  /**
   * Detail-page-only display suffix (e.g. "円" for a money field) —
   * never applied to the form inputs (the label already says "（送料
   *別）"/"円" where relevant via its placeholder), only when the detail
   * page formats a saved value for reading. Deliberately only used on
   * `type: "number"` fields in this registry — a `type: "text"` field
   * like width/depth (spec: 現時点では文字列入力) might already contain
   * its own unit from whatever the user typed, so blindly appending one
   * here could double it up ("120cm cm"); those stay unit-less and rely
   * on their label ("幅（cm）") for context instead.
   */
  unit?: string;
}

export interface ExtendedSectionDef {
  id: string;
  title: string;
  fields: ExtendedFieldDef[];
}

const UNSET_OPTION = { value: "", label: "未設定" };

/**
 * purchasePrice/salePrice are pre-existing core Inventory fields (not
 * part of InventoryExtendedFields — they have their own dedicated,
 * always-number-typed handling in createInventory/updateInventory), but
 * visually belong inside these two sections (spec: 購入価格 is the
 * 仕入・古物台帳's own line item, 販売価格 belongs with 販売情報,
 * distinct from plannedSalePrice/「販売予定価格」). Naming the section
 * ids here — rather than the string literals "sales"/"usedGoodsLedger"
 * repeated in NewInventoryForm.tsx, EditInventoryForm.tsx, and the
 * detail page — is what keeps those three from drifting apart on where
 * each one is injected.
 */
export const SALES_SECTION_ID = "sales";
export const USED_GOODS_LEDGER_SECTION_ID = "usedGoodsLedger";

export const INVENTORY_EXTENDED_SECTIONS: ExtendedSectionDef[] = [
  {
    id: SALES_SECTION_ID,
    title: "販売情報",
    fields: [
      { key: "plannedSalePrice", label: "販売予定価格（送料別）", type: "number", unit: "円" },
      { key: "firstMarkdownPrice", label: "1回目値下げ金額（30日）", type: "text" },
      { key: "secondMarkdownPrice", label: "2回目値下げ金額（60日）", type: "text" },
      { key: "thirdMarkdownPrice", label: "3回目値下げ金額（90日）", type: "text" },
      { key: "saleStartDate", label: "販売開始日", type: "date" },
      { key: "saleEndDate", label: "販売終了日", type: "date" },
      { key: "market", label: "市場", type: "text" },
      { key: "externalProductId", label: "商品ID", type: "text" },
      { key: "saleCommission", label: "販売手数料", type: "number", unit: "円" },
      { key: "listingNotes", label: "出品情報", type: "textarea", fullWidth: true },
    ],
  },
  {
    id: "dimensions",
    title: "サイズ・商品仕様",
    fields: [
      { key: "width", label: "幅（cm）", type: "text" },
      { key: "depth", label: "奥行（cm）", type: "text" },
      { key: "height", label: "高さ（cm）", type: "text" },
      { key: "overallLength", label: "全長（cm）", type: "text" },
      { key: "lengthAdjustable", label: "全長調節可否", type: "select", options: [UNSET_OPTION, { value: "可", label: "可" }, { value: "不可", label: "不可" }] },
      { key: "mountType", label: "取付タイプ", type: "text" },
    ],
  },
  {
    id: "condition",
    title: "コンディション",
    fields: [
      { key: "conditionRating", label: "コンディション評価", type: "textarea", fullWidth: true },
      { key: "damageNotes", label: "傷汚れ箇所等メモ", type: "textarea", fullWidth: true },
    ],
  },
  {
    id: USED_GOODS_LEDGER_SECTION_ID,
    title: "仕入・古物台帳",
    fields: [
      { key: "usedGoodsItemType", label: "品目", type: "text" },
      { key: "transactionDate", label: "取引の年月日", type: "date" },
      { key: "purchaseQuantity", label: "数量（仕入台帳）", type: "number" },
      { key: "transactionType", label: "取引区分", type: "text" },
      { key: "identityVerificationMethod", label: "真偽確認のためにとった措置の区分および方法", type: "text", fullWidth: true },
      { key: "counterpartyName", label: "相手氏名", type: "text" },
      { key: "counterpartyOccupation", label: "職業", type: "text" },
      { key: "counterpartyAddress", label: "住所", type: "text" },
      // 追加修正指示 §9-§10: 送料(shippingCost)は新規登録/編集フォーム
      // の入力欄からは撤去した(BELLOの実運用は「購入価格+送料等の諸経
      // 費込みの原価」をpurchasePriceへ直接入力する方式へ統一するため
      // — 上のUSED_GOODS_LEDGER_SECTION_ID自体がpurchasePriceの注入先で
      // あることに変わりはない、extendedFields.tsのコメント参照)。
      //
      // ただしこのフィールド定義自体・schema・保存済みデータは一切削除
      // していない — 単にこの配列(=フォーム入力欄が参照する一覧)から
      // 取り除いただけ。理由:
      //  ・app/inventory/(protected)/[id]/page.tsxの「D. 古物台帳」表
      //    示は、この配列を経由せずitem.shippingCostを直接参照する独自
      //    実装(仕様上固定の9項目+送料)なので、既存レコードの送料は
      //    詳細画面で引き続き閲覧できる。
      //  ・lib/inventory/exportFields.ts(CSV/Excel入出力)と
      //    lib/inventory/zaicoMapping.ts(ZAICO連携)はどちらもこの配列
      //    ではなく独自のフィールド一覧でshippingCostを参照している
      //    ため、CSV/Excelのインポート・エクスポートおよびZAICO連携の
      //    互換性に一切影響しない。
      //  ・ALL_EXTENDED_FIELDS(この配列のflatMap)から外れるため、
      //    parseExtendedValues()は今後shippingCostキー自体を結果へ含め
      //    なくなる — 更新時は「未指定(そのフィールドに触れない)」を
      //    意味し、既存レコードのshippingCost値を上書き・消去すること
      //    はない(extendedFields.ts冒頭のparseExtendedValuesの説明を
      //    参照)。
      // 完全な非推奨化(schemaからの削除)を行う場合の安全な移行手順は
      // 今回のcommitメッセージ/完了報告に記載した。
      { key: "dailyPurchaseTotal", label: "その日の仕入れ合計金額（他商品含む）", type: "number", unit: "円" },
    ],
  },
  {
    id: "adminMemo",
    title: "管理メモ",
    fields: [{ key: "adminMemo", label: "市川メモ", type: "textarea", fullWidth: true }],
  },
];

/** All extended field defs flattened, in registry order — used wherever iterating by section doesn't matter (init/parse below, and history diffing in app/actions/inventory.ts). */
export const ALL_EXTENDED_FIELDS: ExtendedFieldDef[] = INVENTORY_EXTENDED_SECTIONS.flatMap((s) => s.fields);

/** Builds this form's `Record<string,string>` UI state from anything shaped like an Inventory record (InventoryDetail, or new/page.tsx's duplicateFrom projection) — every value stringified for the plain text/number/date inputs, "" for absent. */
export function extendedValuesFromRecord(source: Partial<Record<ExtendedFieldKey, unknown>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of ALL_EXTENDED_FIELDS) {
    const raw = source[field.key];
    values[field.key] = raw === null || raw === undefined ? "" : String(raw);
  }
  return values;
}

/**
 * Reverses extendedValuesFromRecord for submission. An empty/whitespace
 * string becomes explicit `null`, not an omitted property — on
 * createInventory this is a no-op (an unset optional field is null
 * either way), but on updateInventory it's what actually lets clearing a
 * field out in the edit form clear it in the database too: Amplify's
 * `.update()` only ever touches fields it's explicitly given, so
 * omitting a cleared field would silently leave the old value in place
 * instead. A number field that doesn't parse to a real number is
 * treated the same as empty (null) rather than sent as NaN, which
 * AppSync would reject outright.
 */
export function parseExtendedValues(values: Record<string, string>): InventoryExtendedFields {
  const result: Record<string, string | number | null> = {};
  for (const field of ALL_EXTENDED_FIELDS) {
    const raw = values[field.key]?.trim();
    if (!raw) {
      result[field.key] = null;
      continue;
    }
    if (field.type === "number") {
      const n = Number(raw);
      result[field.key] = Number.isNaN(n) ? null : n;
    } else {
      result[field.key] = raw;
    }
  }
  return result as InventoryExtendedFields;
}
