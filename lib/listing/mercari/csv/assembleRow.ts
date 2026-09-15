/**
 * `buildExportRowForInventory`(lib/listing/mercari/csv/buildExportRows.ts)
 * が実DB(Inventory/ListingDraft/ChannelListing)を取得した「後」の、
 * 純粋な組み立てロジックだけを切り出したもの。
 *
 * なぜ分けたか: buildExportRows.tsは"server-only"+`next/headers`を
 * 読み込むため、Next.jsのRSCランタイム外(素のNode/tsxの合成fixture
 * テスト)からは直接importできない(`with-server-only-stub.cjs`は
 * "server-only"パッケージ自体は無効化できるが、`next/headers`はNext.js
 * アプリの外では動かない)。この判定ロジックには本来AWS/Next依存が
 * 無いため、副作用の無いこのファイルへ切り出し、
 * scripts/verify-mercari-csv-export.tsから直接呼んで合成fixtureで
 * 検証できるようにする(実DBを一切叩かない)。
 */
import { resolveEffectiveListingFields } from "@/lib/listing/types";
import type { ChannelListingRecord, ListingDraftRecord } from "@/lib/listing/types";
import { conditionCodeToCsvValue } from "./conditionCode";
import type { MercariCsvRowFields } from "./types";

/** 発送元の地域の既定値。既存運用(§4)に基づく初期設定——埼玉。 */
export const DEFAULT_SHIPPING_ORIGIN_AREA = "jp11";

/**
 * 発送までの日数/配送料の負担の既定値(task_d2082e63dfcee9e1bf、
 * 2026-09-15是正)。
 *
 * 経緯: 実CUA(tab81)が合成商品e2e-inv-48の出品編集画面を開いた際、
 * ユーザーから「発送までの日数=4〜7日(3)/配送料の負担=送料込み(1)を
 * 明示の既定値とする」と直接指示された。その後の候補
 * (23b1d3e4f9dda6ebb0273baf861fe4c15c6722afに至る系列)ではこの既定値が
 * 実装されていたが、さらに後続の候補で「BELLOには確認済みの既定値が
 * 無い」という旧要件のコメント・テストへ差し戻され、既定値そのものが
 * 撤去される退行が起きた。旧コメントはこの撤去の"根拠"としてコード上に
 * 残っていたが、ユーザーが実機で明示した既定値の方が優先する
 * (旧仕様コメントより後勝ちのユーザー指示が根拠)。
 *
 * MercariCategoryMappingSection.tsx(保存前の表示)とここ(CSV生成時の
 * 実解決)が同じ定数を参照することで、表示上の初期値とCSV生成結果が
 * 食い違う実装(表示だけ既定値でCSV生成時は未確定ブロックする、のような
 * 状態)を避ける——保存/再読込/一括CSVのいずれでも同一の既定値解決を
 * 共有する。
 *
 * 保存済みの実値(mercariShippingDays/mercariShippingPayerが明示的に
 * 設定されている場合)は絶対に上書きしない——下の`?? DEFAULT_...`は
 * 「未設定(undefined)の時だけ」既定値を補う分岐であり、1〜2日/送料別
 * 等ユーザーが選んだ値をここで書き換えることはない。
 */
export const DEFAULT_MERCARI_SHIPPING_DAYS = 3;
export const DEFAULT_MERCARI_SHIPPING_PAYER = 1;

/**
 * 配送方法/CSV公開設定の既定値(task_1d6008f0c4f2ef3468、2026-09-15
 * 追加)。実績CSV531件の共通値採用指示に基づく——配送方法は既存確認済み
 * 運用(出品者手配)、CSV公開設定は「公開」(旧実装は指示書の既定値
 * レビュー前の暫定値として1=非公開を固定出力していたが、実績分析の
 * 結果2=公開が共通値だった)。どちらも保存済みの実値
 * (mapping.mercariShippingMethod/mercariCsvProductStatus)があれば
 * そちらを優先し、未設定の時だけこの既定値を補う。
 */
export const DEFAULT_MERCARI_SHIPPING_METHOD = 1;
export const DEFAULT_MERCARI_CSV_PRODUCT_STATUS = 2;

export interface RowBuildSuccess {
  ok: true;
  fields: MercariCsvRowFields;
  /** タイトル/説明/価格がどこから来たか(プレビュー表示用)。 */
  provenance: { title: "draft" | "override"; description: "draft" | "override"; price: "draft" | "override" };
}

export interface RowBuildFailure {
  ok: false;
  inventoryId: string;
  displayId: string;
  reasons: string[];
}

export type RowBuildResult = RowBuildSuccess | RowBuildFailure;

export function imageFilename(storageKey: string, displayId: string, sortOrder: number): string {
  const ext = storageKey.includes(".") ? storageKey.slice(storageKey.lastIndexOf(".")) : ".jpg";
  return `${displayId}_${sortOrder + 1}${ext}`;
}

/** `assembleMercariCsvRowFields`が読む在庫側の最小限の形(InventoryDetailの部分集合)。 */
export interface CsvSourceInventory {
  displayId: string;
  quantity: number;
  sku: string;
  barcode: string | null;
}

/**
 * 1商品分をMercari Shops CSVの論理フィールドへ組み立てる(純粋関数、
 * 外部I/Oなし)。
 *
 * - タイトル/説明/価格は`ListingDraft`(保存済みEC下書き)を土台にし、
 *   `ChannelListing(MERCARI_SHOPS)`のoverrideがあればそちらを使う
 *   (`resolveEffectiveListingFields`——既存の「Channel Override」の
 *   仕組みをそのまま再利用し、成約済販売価格を出品価格へ転用しない)。
 * - 下書きが無い商品は呼び出し側(buildExportRowForInventory)で先に
 *   ブロックしている前提(draftはnon-nullとして受け取る)。
 * - 発送までの日数(shippingDays)は`channelListing.categoryMapping.
 *   mercariShippingDays`——MercariCategoryMappingSectionで人が選んで
 *   保存した実値があればそれを使い、未設定(undefined)なら
 *   `DEFAULT_MERCARI_SHIPPING_DAYS`(=3、4〜7日)を適用する
 *   (task_d2082e63dfcee9e1bf、ユーザー明示の既定値)。保存済みの実値が
 *   ある場合はここで上書きしない。
 * - 配送料の負担(shippingPayer)も同様に`channelListing.categoryMapping.
 *   mercariShippingPayer`があればそれを使い、未設定なら
 *   `DEFAULT_MERCARI_SHIPPING_PAYER`(=1、送料込み)を適用する。
 * - 販売価格(salePrice)は丸めない——非整数はここで補正せず
 *   validateMercariCsvRow(validate.ts)にそのまま渡してブロックさせる
 *   (指示書§4「価格は丸めず検証、不正なら修正要求」)。
 * - 在庫マスタ(Inventory)は一切書き換えない(読み取りのみ)。
 */
export function assembleMercariCsvRowFields(
  inventoryId: string,
  inventory: CsvSourceInventory,
  draft: ListingDraftRecord,
  channelListing: ChannelListingRecord | null,
): RowBuildResult {
  const displayId = inventory.displayId;

  if (channelListing && ["SOLD", "ENDED", "ARCHIVED"].includes(channelListing.status)) {
    return {
      ok: false,
      inventoryId,
      displayId,
      reasons: [`この商品は現在のステータスが「${channelListing.status}」のため対象外です`],
    };
  }

  if (!Number.isInteger(inventory.quantity) || inventory.quantity <= 0) {
    return {
      ok: false,
      inventoryId,
      displayId,
      reasons: [`在庫数が${inventory.quantity}のため対象外です(0/不正な数量を1へ黙って補完しません)`],
    };
  }

  if (!draft.condition) {
    return { ok: false, inventoryId, displayId, reasons: ["商品の状態が下書きに未設定です"] };
  }

  const resolved = channelListing
    ? resolveEffectiveListingFields(draft, channelListing)
    : { title: draft.title, description: draft.description ?? "", price: draft.price ?? 0 };

  if (!draft.title && !channelListing?.overrideTitle) {
    return { ok: false, inventoryId, displayId, reasons: ["タイトルが未設定です"] };
  }
  if (resolved.price <= 0) {
    return { ok: false, inventoryId, displayId, reasons: ["出品価格が未設定です(成約済み販売価格を黙って転用しません)"] };
  }

  const categoryId = channelListing?.categoryMapping?.mercariCategoryId ?? null;
  if (!categoryId) {
    return {
      ok: false,
      inventoryId,
      displayId,
      reasons: ["Mercariカテゴリが未確定です。カテゴリマスタのフルパスから選び直してください"],
    };
  }

  // 未設定(undefined)なら既定値(4〜7日)を適用する。保存済みの実値が
  // あれば(1〜2日等)そちらを優先し、ここで上書きしない
  // (task_d2082e63dfcee9e1bf、ユーザー明示の既定値)。
  const shippingDays = channelListing?.categoryMapping?.mercariShippingDays ?? DEFAULT_MERCARI_SHIPPING_DAYS;

  // 配送料の負担(shippingPayer)。未設定(undefined)なら既定値(送料込み)
  // を適用する。保存済みの実値(送料別等)があればそちらを優先する。
  const shippingPayer = channelListing?.categoryMapping?.mercariShippingPayer ?? DEFAULT_MERCARI_SHIPPING_PAYER;

  // 発送元/配送方法/CSV公開設定(task_1d6008f0c4f2ef3468、2026-09-15
  // 追加)。他のmercari*フィールドと同じ解決規則: 保存済みの実値が
  // あればそちらを優先し、未設定(undefined)の時だけ既定値を補う。
  const shippingOriginArea = channelListing?.categoryMapping?.mercariShippingOriginArea ?? DEFAULT_SHIPPING_ORIGIN_AREA;
  const shippingMethod = channelListing?.categoryMapping?.mercariShippingMethod ?? DEFAULT_MERCARI_SHIPPING_METHOD;
  const productStatus = channelListing?.categoryMapping?.mercariCsvProductStatus ?? DEFAULT_MERCARI_CSV_PRODUCT_STATUS;

  if (draft.images.length === 0) {
    return { ok: false, inventoryId, displayId, reasons: ["下書きに画像がありません"] };
  }

  const images = draft.images
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((img, idx) => imageFilename(img.storageKey, displayId, idx));

  const managementCode = inventory.sku;

  const fields: MercariCsvRowFields = {
    inventoryId,
    displayId,
    images,
    productName: resolved.title,
    productDescription: resolved.description,
    skuType: null,
    quantity: inventory.quantity,
    managementCode,
    janCode: inventory.barcode ?? null,
    catalogId: null,
    brandId: channelListing?.categoryMapping?.mercariBrandId ?? null,
    // 丸めない——指示書§4「価格は丸めず検証、不正なら修正要求」。
    // 非整数(下書き保存時に何らかの経路で混入した端数)をここで
    // Math.truncして黙って丸めると、validateMercariCsvRow(validate.ts)
    // の`Number.isInteger`チェックが常に通ってしまい、利用者が実際には
    // 気づけないまま丸められた価格でCSVが出てしまう。ここでは生の値を
    // 渡し、非整数ならvalidate.ts側でブロックして利用者に修正を求める。
    salePrice: resolved.price,
    categoryId,
    condition: conditionCodeToCsvValue(draft.condition),
    // 配送方法(shippingMethod)。実績共通値は既存確認済み運用(1=出品者
    // 手配)だが、実績には3(らくらくメルカリ便)の例外があるため商品
    // ごとに変更できる(mapping.mercariShippingMethod)。配送料の負担
    // (shippingPayer)は上で未設定なら既定値を補っているため、ここに
    // 来る時点で1か2のどちらかが必ず入っている。
    shippingMethod,
    shippingOriginArea,
    shippingDays,
    productStatus,
    shippingPayer,
    // 送料ID(task_ca862bd2a1f6fbf60d、2026-09-15是正): 配送料の負担が
    // 「送料別」(2)の時だけmapping.mercariShippingFeeIdを渡す。送料込
    // (1)へ切り替えた後もmapping側の値自体は消さない設計
    // (MercariCategoryMappingSection.tsx参照)なので、ここでpayer===2の
    // 時だけに絞らないと「送料込に戻したのにCSVへ古い送料IDが残る」
    // 事故になる——指示書§4「送料込への切替ではCSVにIDを出さない」。
    // 未入力(null/undefined)ならnullのまま渡し、必須チェックは
    // validateMercariCsvRow(validate.ts)側の責務のままにする(ここで
    // ブロックしない——買い手向けの理由文言はvalidate.ts側に集約する)。
    shippingFeeId: shippingPayer === 2 ? channelListing?.categoryMapping?.mercariShippingFeeId ?? null : null,
    bizCoolCategory: null,
  };

  return {
    ok: true,
    fields,
    provenance: {
      title: channelListing?.overrideTitle ? "override" : "draft",
      description: channelListing?.overrideDescription ? "override" : "draft",
      price: channelListing?.overridePrice != null ? "override" : "draft",
    },
  };
}
