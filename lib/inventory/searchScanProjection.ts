/**
 * 検索が「その検索のために本当に読む必要のある列」だけを DynamoDB から
 * 取り出すための ProjectionExpression を、検索条件から機械的に組み立てる
 * (2026-09-04 性能改善 第2フェーズ §1)。
 *
 * 純粋なデータ変換のみ。server-only ではないので、テストから直接検査できる。
 *
 * ── なぜ必要か(実測) ────────────────────────────────────────────
 *
 * 検索は3経路とも lib/inventory/queries.ts の fetchAllInventoryRecords を
 * 通り、**非削除の在庫を全件**読んでから application code 側で絞り込んで
 * いた。部分一致・case-insensitive・AND/OR 混在という仕様は DynamoDB の
 * 式では表現しきれないので、絞り込み自体をアプリ側でやること自体は正しい。
 *
 * 問題は「絞り込みに使わない列まで全部運んでいた」こと。Staging 実測
 * (在庫5,329件・同じ Scan・同じ条件):
 *
 *   全列                     17,789ms / 14往復 / 11.83MB
 *   検索に要る列だけ           2,798ms / 14往復 /  1.95MB
 *
 * 6.4倍。往復数が変わらないのは DynamoDB の1ページ1MB上限が**射影より
 * 前**に効くため —— 減るのは転送量とJSONの組み立て時間で、そこが実測上
 * 支配的だった。
 *
 * ── なぜ AppSync の selectionSet では足りないのか ────────────────
 *
 * selectionSet は AppSync が**返す**項目を絞るだけで、DynamoDB→AppSync
 * 間は常に全列が流れる。射影を DynamoDB 自身に効かせるには、
 * ProjectionExpression を指定できる直結経路が要る
 * (lib/inventory/inventoryCountFast.ts と同じ理由・同じ扱い)。
 *
 * ── 「列を絞ったら検索が静かに壊れる」をどう防ぐか ────────────────
 *
 * lib/inventory/searchProjection.ts と同じ考え方: **人が列を並べない**。
 * 実行中の検索条件が参照する検索フィールドキーから、その都度必要な
 * 属性名を導出する。導出規則は下の attributesForSearchFieldKey ただ1つで、
 * scripts/verify-inventory-search-fast.ts が実データで
 * 「新旧の検索結果(件数・ID・順序・行の中身)が完全一致するか」を照合する。
 */

/**
 * どの検索でも必ず要る属性。
 *
 *   id                                 … 行の取得キー・安定ソートの同点処理
 *   updatedAt                          … 並び順(compareByUpdatedAtDesc)
 *   sku / sourceSystem / sourceInventoryId … 表示用「在庫ID」の導出とクイック検索
 *   name                               … クイック検索
 *   deletedAt は FilterExpression 側で使うので射影には不要。
 */
export const ALWAYS_SCANNED_ATTRIBUTES = [
  "id",
  "updatedAt",
  "sku",
  "name",
  "sourceSystem",
  "sourceInventoryId",
] as const;

/**
 * 検索フィールドのキー → 実際に読む DynamoDB の属性名。
 *
 * 静的検索フィールドのキーは、`displayId` を除いてすべて Inventory の
 * 属性名そのもの(lib/inventory/queries.ts の toListRow / toExtendedFields
 * が同名で写しているだけ)。この対応が崩れていないことは
 * scripts/verify-search-projection.ts が Inventory モデル定義と突き合わせる。
 */
export function attributesForSearchFieldKey(key: string): string[] {
  // 表示用の在庫IDは保存された列ではなく導出値(lib/inventory/inventoryId.ts)。
  if (key === "displayId") return ["sku", "sourceSystem", "sourceInventoryId"];
  // 動的な追加項目は customFields(AWSJSON文字列)の中。個別に射影できない。
  if (key.startsWith("cf:")) return ["customFields"];
  return [key];
}

export interface ScanProjection {
  projectionExpression: string;
  names: Record<string, string>;
  /** 実際に読む属性名(テスト・計測用)。 */
  attributes: string[];
}

/**
 * 追加で読みたい検索フィールドキー群から ProjectionExpression を作る。
 *
 * 属性名は**すべて** `#p0, #p1, …` に置き換える。`name` `status` `size`
 * のような DynamoDB の予約語をうっかり素で書くと、その検索だけが実行時に
 * 落ちる —— 予約語リストを人が管理しないで済むようにしておく。
 */
export function buildScanProjection(fieldKeys: Iterable<string> = []): ScanProjection {
  const attrs = new Set<string>(ALWAYS_SCANNED_ATTRIBUTES);
  for (const key of fieldKeys) {
    for (const attr of attributesForSearchFieldKey(key)) attrs.add(attr);
  }
  const attributes = [...attrs].sort();
  const names: Record<string, string> = {};
  const parts = attributes.map((attr, i) => {
    names[`#p${i}`] = attr;
    return `#p${i}`;
  });
  return { projectionExpression: parts.join(", "), names, attributes };
}
