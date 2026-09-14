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
 *   保存した実値のみを使い、未選択なら黙って既定値を出さずブロックする
 *   (指示書§4「確認済み設定がなければ利用者選択必須」)。
 * - 配送料の負担(shippingPayer)も同様に`channelListing.categoryMapping.
 *   mercariShippingPayer`のみを使う——BELLOには既存の確認済み運用値が
 *   無い(lib/listing/types.tsのShippingPayerCode削除コメント参照)ため
 *   未選択を「送料込」へ黙って固定しない(指示書§4「既存確認済値を
 *   採用し不明は選択」)。
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

  const shippingDays = channelListing?.categoryMapping?.mercariShippingDays ?? null;
  if (!shippingDays) {
    return {
      ok: false,
      inventoryId,
      displayId,
      reasons: ["発送までの日数が未選択です。EC出品編集画面のMercariカテゴリー欄で選択してください(確認済み設定が無いため利用者選択が必須です)"],
    };
  }

  // 配送料の負担(shippingPayer)。BELLOには「送料を誰が負担するか」を
  // 表す既存の確認済み運用値が無い(lib/listing/types.tsの624307eでの
  // ShippingPayerCode削除コメント参照)ため、shippingDaysと同じく
  // 未選択を黙って「送料込」へ固定せず、人が選んだ値のみを使う。
  const shippingPayer = channelListing?.categoryMapping?.mercariShippingPayer ?? null;
  if (!shippingPayer) {
    return {
      ok: false,
      inventoryId,
      displayId,
      reasons: ["配送料の負担が未選択です。EC出品編集画面のMercariカテゴリー欄で選択してください(既存の確認済み運用値が無いため利用者選択が必須です)"],
    };
  }

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
    // 配送方法(shippingMethod)は現時点で唯一の既存確認済み運用
    // (出品者手配、指示書§4「既存出品者手配の運用を確認し1への対応を
    // 根拠化」)のため固定値。配送料の負担(shippingPayer)は上でブロック
    // 済みなので、ここに来る時点で1か2のどちらかが必ず選択されている。
    shippingMethod: 1,
    shippingOriginArea: DEFAULT_SHIPPING_ORIGIN_AREA,
    shippingDays,
    productStatus: 1,
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
