import "server-only";
import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { MercariApiError, MercariShopsClient } from "./client";
import { getMercariEnvironment } from "./endpoints";
import { getMercariAccessToken } from "./tokenAccess";
import { CREATE_PRODUCT_MUTATION } from "./mutations";
import { PRODUCT_CATEGORIES_QUERY, type ProductCategoriesResponse } from "./queries";
import type { CreateProductInput, CreateProductPayload } from "./types";
import { conditionToMercariValue } from "./mapper/condition";
import { shippingPayerToMercariValue } from "./mapper/shippingPayer";
import { shippingDurationToMercariValue } from "./mapper/shippingDuration";
import { internalStatusToMercariApiStatus } from "./mapper/productStatus";
import type { ChannelListingRecord, ListingDraftRecord, ShippingPayerCode } from "../types";
import { resolveEffectiveListingFields } from "../types";

/**
 * BELLO統合改修 master指示書 Phase D — Mercari Shopsアダプタ。
 * origin/claude/mercari-shops-auto-listing-ag0w6m branchの
 * domain/adapters/MercariShopsAdapter.tsを"アーキテクチャとして"移植した
 * もの(検証→CreateProductInput組み立て→GraphQL呼び出し→結果の永続化、
 * という流れは同一) — ただし実装そのものは書き直している。元の実装は
 * Prisma(`prisma.product`/`prisma.mercariListing`)前提だったが、この
 * アプリはAmplify Data(ListingDraft/ChannelListing)を使うため、
 * データアクセス層を丸ごと差し替える必要があった(master指示書の指示
 * 「Prismaベースのプロジェクト全体をマージするのではなく、再利用可能な
 * ビジネス/APIロジックをこのアプリのアダプタとして移植する」)。
 *
 * 変更点まとめ:
 * - 商品データ取得: prisma.product.findUniqueOrThrow → 呼び出し元
 *   (lib/listing/service.ts)がListingDraftRecord/ChannelListingRecord
 *   を渡す形にした(このファイル自体はAmplify Dataを直接読まない —
 *   service.tsが唯一の読み書き窓口という既存の分離方針に合わせた)。
 * - 画像URL: 元は`img.publicUrl`(公開バケット前提)だったが、BELLOの
 *   S3バケットはCognitoグループのみアクセス可能な非公開バケット
 *   (amplify/storage/resource.tsのinventory/*ルール参照、意図的に
 *   publicApiKeyルールを一切持たない)。そのため、この関数は出品実行の
 *   直前にサーバー側でgetUrl()による署名付きURL(有効期限つき)を都度
 *   生成して渡す。
 *   [ARCHITECTURE CAVEAT] MercariがcreateProduct呼び出しの応答後、
 *   非同期に(数分〜それ以上遅れて)画像を取得しにくるアーキテクチャ
 *   だった場合、この署名付きURLが期限切れになり画像取得に失敗する
 *   リスクがある — Mercari Shops APIの実際の画像取得タイミングは
 *   [UNVERIFIED](Sandbox接続不可のため確認できていない)。もしこれが
 *   実際に問題になった場合の恒久対応は、出品用画像だけを別途「公開だが
 *   推測困難なURL」を持つ専用の配信経路(例: 署名付きCloudFront
 *   Distribution)へコピーする方式に切り替えることで、BELLO本体の
 *   バケットを非公開のまま保てる。Phase Dの時点ではこの恒久対応は
 *   スコープ外とし、まずは長め(getUrlのexpiresIn上限、Cognito
 *   Identity Poolの一時認証情報が許す範囲)の署名付きURLで実装している。
 * - トークン取得: prisma越しのAppSetting(MercariSettingsService) →
 *   lib/listing/mercari/secretStore.ts(AWS Secrets Manager) — ZAICO
 *   TOKENと同じ設計。
 * - ログ: integrationLoggerは無し(BELLOにその仕組みがそもそも無い) —
 *   console.error + ChannelListing.lastErrorへの永続化で代替。
 * - shippingMethod/shippingFromStateId/shippingConfigurationId等、元の
 *   実装が参照していたPhase 2的な配送設定フィールド(ShippingTemplate
 *   等)はBELLOにまだ存在しない — Phase Dでは固定のフォールバック値
 *   ([UNVERIFIED]、元ブランチのFALLBACK_SHIPPING_METHODと同じ位置づけ)
 *   を使い、コメントで明示している。将来これらを商品ごとに選択可能に
 *   する場合は、ChannelListing.categoryMapping同様のJSON列を追加すれば
 *   足りる(新しいモデルは不要)。
 */

/** [UNVERIFIED] 配送方法の暫定フォールバック値。元ブランチのFALLBACK_SHIPPING_METHODと同じ位置づけ。 */
const FALLBACK_SHIPPING_METHOD = "MERCARI_SHIPPING";
/** [UNVERIFIED] 配送元地域の暫定フォールバック値 — BELLOにはまだ「配送元地域」という設定項目が無いため。 */
const FALLBACK_SHIPPING_FROM_STATE_ID = "13"; // 東京都 [UNVERIFIED]

export interface MercariListingInput {
  draft: ListingDraftRecord;
  channelListing: ChannelListingRecord;
  /** BELLOにはまだ永続化された「送料負担者」フィールドが無いため、呼び出し元(Server Action)が都度渡す — lib/listing/types.tsのShippingPayerCodeコメント参照。 */
  shippingPayer: ShippingPayerCode;
}

export interface MercariListingResult {
  externalProductId: string;
  externalStatus: string | null;
}

function client(): MercariShopsClient {
  const environment = getMercariEnvironment();
  return new MercariShopsClient({ environment, getAccessToken: getMercariAccessToken });
}

/**
 * `storageKey`を、Mercari側が取得できる署名付きURLへ変換する。
 * このアプリの他のgetUrl()呼び出し(app/inventory/useInventoryImageUrl.ts
 * 等)と違い、こちらはサーバー側(aws-amplify/storage/server)から呼ぶ
 * — 出品処理はServer Action/Server-side serviceの中で完結し、ブラウザ
 * のCognitoセッションには依存しない。
 */
async function resolveImageUrlForMercari(storageKey: string): Promise<string> {
  const { url } = await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) => getUrl(contextSpec, { path: storageKey, options: { expiresIn: 3600 } }), // 1時間 — Cognito Identity Poolの一時認証情報が許す範囲の実用的な上限
  });
  return url.toString();
}

/**
 * Mercari Shopsへの新規出品(createProduct)。バリデーション(カテゴリ
 * マッピング必須・画像1枚以上必須)→CreateProductInput組み立て→
 * GraphQL呼び出し、まで一貫して行う。永続化(ChannelListing.status/
 * externalListingId/listingUrl/lastErrorの更新)は呼び出し元
 * (lib/listing/service.ts)の責務 — このアダプタ自体はAmplify Dataへ
 * 一切書き込まない(READ ONLY境界: Listingの書き込み経路を
 * service.tsの1箇所に集約するため)。
 */
export async function createMercariProduct(input: MercariListingInput): Promise<MercariListingResult> {
  const { draft, channelListing, shippingPayer } = input;

  if (!channelListing.categoryMapping?.mercariCategoryId) {
    throw new Error("Mercariのカテゴリーが未設定です。末端カテゴリーを選択してください。");
  }
  if (draft.images.length === 0) {
    throw new Error("画像が1枚も登録されていません。出品するにはInventory側に少なくとも1枚の画像が必要です。");
  }

  const effective = resolveEffectiveListingFields(draft, channelListing);
  const images = await Promise.all(
    [...draft.images]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(async (img, idx) => ({ url: await resolveImageUrlForMercari(img.storageKey), sortOrder: idx })),
  );

  const conditionCode = draft.condition ?? "NO_NOTABLE_DAMAGE"; // 未設定時のフォールバック — Inventory側は自由記述のconditionRatingしか持たないため、Listing DraftはBELLO側で明示的に選び直す前提

  const apiInput: CreateProductInput = {
    name: effective.title,
    description: effective.description,
    price: effective.price,
    categoryId: channelListing.categoryMapping.mercariCategoryId,
    condition: conditionToMercariValue(conditionCode),
    images,
    shippingPayer: shippingPayerToMercariValue(shippingPayer),
    // [UNVERIFIED] 配送方法/配送元地域はBELLOにまだ商品ごとの設定項目が
    // 無いため固定フォールバック — adapter.tsファイル冒頭コメント参照。
    shippingMethod: FALLBACK_SHIPPING_METHOD,
    shippingDuration: shippingDurationToMercariValue("FOUR_SEVEN_DAYS"),
    shippingFromStateId: FALLBACK_SHIPPING_FROM_STATE_ID,
    status: internalStatusToMercariApiStatus(channelListing.status),
    variants: [{ skuCode: draft.inventoryId, stockQuantity: 1 }],
  };

  const data = await client().request<CreateProductPayload>(CREATE_PRODUCT_MUTATION, { input: apiInput }, { disableRetry: true });

  return {
    externalProductId: data.createProduct.product.id,
    externalStatus: data.createProduct.product.status ?? null,
  };
}

/**
 * 出品用のカテゴリー選択肢を取得する — 出品下書き編集UIのカテゴリー
 * 選択に使う。TOKEN保存前の疎通確認(app/actions/mercariSecret.ts)にも
 * この同じクエリを流用する(書き込みを一切伴わない最も軽量な確認)。
 */
export async function fetchMercariCategories(): Promise<ProductCategoriesResponse["productCategories"]> {
  const data = await client().request<ProductCategoriesResponse>(PRODUCT_CATEGORIES_QUERY, {});
  return data.productCategories;
}

/**
 * 指定したトークンで実際にMercari Shops APIへ疎通できるかを確認する
 * (app/actions/zaicoSecret.tsのvalidateZaicoTokenと同じ「保存前に検証
 * する」パターン)。渡されたtokenだけを使い、Secrets Manager/環境変数
 * には一切触れない — 保存が確定する前の検証専用。
 */
export async function validateMercariToken(token: string): Promise<{ ok: boolean; message: string }> {
  const environment = getMercariEnvironment();
  const testClient = new MercariShopsClient({ environment, getAccessToken: async () => token });
  try {
    await testClient.request<ProductCategoriesResponse>(PRODUCT_CATEGORIES_QUERY, {}, { disableRetry: true });
    return { ok: true, message: `Mercari Shops API（${environment}）への接続を確認しました。` };
  } catch (err) {
    const message = err instanceof MercariApiError ? err.message : err instanceof Error ? err.message : "不明なエラー";
    return { ok: false, message: `Mercari Shops APIへの接続に失敗しました: ${message}` };
  }
}

export { MercariApiError };
