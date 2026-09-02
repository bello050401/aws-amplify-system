import { ALL_EXTENDED_FIELDS } from "./extendedFields";
import { INVENTORY_LIST_COLUMNS } from "./listColumns";

/**
 * 検索・一覧が実際に読む列だけを取り出すための projection(2026-09-02 指示書§10/§11)。
 *
 * 純粋なデータのみ。server-only ではないので、テストから直接検査できる。
 *
 * ── なぜ「人が列を並べる」形にしないのか ────────────────────────
 *
 * 前回の夜間作業が images の除外を見送った理由がここに書いてある:
 *
 *   > Amplifyの selectionSet は必要な列を全部列挙する形なので、1つでも
 *   > 漏らすとその列が undefined になり、詳細検索の判定が静かに壊れる。
 *
 * まったくそのとおりで、手で並べる限りこの危険は消えない。だから
 * **列挙を人が書かない**。この配列は
 *
 *   INVENTORY_LIST_COLUMNS(一覧が表示する列)
 *   ALL_EXTENDED_FIELDS  (Phase Cで足された全フィールド)
 *   STRUCTURAL_FIELDS    (id/並び順/論理削除など、表示されないが要る列)
 *
 * の**和集合として組み立てる**。新しい検索項目やリスト列を足した人が
 * このファイルを触り忘れても、その項目は自動的に projection へ入る。
 *
 * さらに scripts/verify-search-projection.ts が、
 * 「検索フィールド定義に載っている静的キーがすべて projection に
 * 含まれているか」を機械的に照合する —— 漏れがあればテストが落ちる。
 *
 * ── images をどう扱うか ────────────────────────────────────────
 *
 * 実測(Staging 5,313件): images は payload の 2,516KB / 6,280KB = 40.1%。
 * ただし一覧が必要なのは「代表画像1枚のサムネイルのキー」だけで、
 * 代表画像の決定に使うのは isPrimary / type / sortOrder、キーの解決に
 * 使うのは thumbnailKey / storageKey だけ(lib/inventory/imageTypes.ts の
 * resolveTopImage と effectiveListThumbnailKey)。
 *
 * 残りの sourceUrl(S3の長いURL)/ originalHash(SHA-256の64文字)/
 * sourceSystem / classification は一覧でも検索でも一度も参照されない。
 * images 配列そのものを落とすのではなく、**使わない子フィールドだけ**を
 * 落とす —— サムネイルは今までどおり出る。
 */

/** 表示されないが、動作に必要な列。 */
const STRUCTURAL_FIELDS = [
  "id",
  "sku",
  "name",
  // 並び順(compareByUpdatedAtDesc)と作成日時の表示。
  "createdAt",
  "updatedAt",
  // 論理削除の除外。
  "deletedAt",
  // マスタ参照(カテゴリ/保管場所/状態での絞り込み)。
  "categoryId",
  "locationId",
  "statusId",
  // 在庫ID表示の解決(resolveDisplayInventoryId)。
  "sourceSystem",
  "sourceInventoryId",
  // 動的な追加項目。JSON文字列なので、中身の列挙はできない = 常に丸ごと要る。
  "customFields",
  "quantity",
  "unit",
  "purchasePrice",
  "salePrice",
  "note",
  // toExtendedFields が読むのに ALL_EXTENDED_FIELDS には載っていない。
  // 送料(shippingCost)は新規登録/編集フォームの入力欄からは撤去された
  // が、列・schema・保存済みデータ・CSV入出力・ZAICO連携はすべて生きて
  // いる(lib/inventory/extendedFields.ts の該当コメント)。フォームの
  // 一覧から外れているだけなので、和集合の材料としては拾えない。
  //
  // これは scripts/verify-search-projection.ts が実際に見つけた欠落。
  // 「人が列挙しない」設計でも、材料そのものが不完全なら漏れる ——
  // だから照合テストのほうを正本にしている。
  "shippingCost",
] as const;

/**
 * images のうち一覧・検索が実際に読む子フィールド。
 *
 * ここに載っていない子フィールド(sourceUrl / originalHash /
 * sourceSystem / classification)は、一覧でも検索でも参照されない。
 * 詳細画面・画像編集画面は別の取得経路(getInventoryDetail)を使うので、
 * そちらには影響しない。
 */
export const SEARCH_IMAGE_SUBFIELDS = ["storageKey", "thumbnailKey", "isPrimary", "type", "sortOrder"] as const;

/**
 * 一覧の列のうち、**Inventory の実在する列ではないもの**。
 *
 * 表示上の列であって、値は取得後に別のところから解決する:
 *   image    → images(子フィールドで取る)
 *   category → categoryId からカテゴリマスタを引く
 *   location → locationId から保管場所マスタを引く
 *   status   → statusId から状態マスタを引く
 *   displayId→ sourceSystem / sourceInventoryId / sku から導出
 *
 * これらをそのまま selectionSet へ入れると、AppSync が「そんなフィールドは
 * 無い」と GraphQL のバリデーションで落とす。解決の材料になる列
 * (categoryId 等)は STRUCTURAL_FIELDS 側に入っている。
 */
const VIRTUAL_LIST_COLUMNS = new Set(["image", "category", "location", "status", "displayId"]);

/** images を除いた、検索・一覧が読むスカラー列(重複排除済み・安定順)。 */
export const SEARCH_SCALAR_FIELDS: string[] = (() => {
  const keys = new Set<string>(STRUCTURAL_FIELDS);
  for (const c of INVENTORY_LIST_COLUMNS) {
    // 動的な追加項目の列("cf:xxx")は customFields に含まれるので個別には要らない。
    if (c.key.startsWith("cf:")) continue;
    if (VIRTUAL_LIST_COLUMNS.has(c.key)) continue;
    keys.add(c.key);
  }
  for (const f of ALL_EXTENDED_FIELDS) keys.add(f.key);
  return [...keys].sort();
})();

/**
 * Amplify Data の `selectionSet` へそのまま渡せる形。
 * images は子フィールド指定(`images.thumbnailKey` 等)で絞る。
 */
export const INVENTORY_SEARCH_SELECTION_SET: string[] = [
  ...SEARCH_SCALAR_FIELDS,
  ...SEARCH_IMAGE_SUBFIELDS.map((f) => `images.${f}`),
];

/**
 * projection に含まれていない列を読もうとしていないか、呼び出し側が
 * 自己申告するためのヘルパー(テストが使う)。
 */
/**
 * DBの列ではなく、取得後に組み立てる派生値。
 *
 * displayId は resolveDisplayInventoryId(sourceSystem / sourceInventoryId /
 * sku から導出)で、Inventory に同名の列は存在しない。検索フィールド定義
 * には載るので、projection の照合では「材料が揃っているか」で判定する。
 */
const DERIVED_FIELDS: Record<string, string[]> = {
  displayId: ["sourceSystem", "sourceInventoryId", "sku"],
  category: ["categoryId"],
  location: ["locationId"],
  status: ["statusId"],
  image: [],
};

export function isFieldInSearchProjection(field: string): boolean {
  const derivedFrom = DERIVED_FIELDS[field];
  if (derivedFrom) return derivedFrom.every((f) => SEARCH_SCALAR_FIELDS.includes(f));
  if (field.startsWith("images.")) {
    return (SEARCH_IMAGE_SUBFIELDS as readonly string[]).includes(field.slice("images.".length));
  }
  return SEARCH_SCALAR_FIELDS.includes(field);
}
