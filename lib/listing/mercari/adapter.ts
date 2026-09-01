import "server-only";
import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { MercariApiError, MercariShopsClient, type MercariErrorCode } from "./client";
import { getMercariEnvironment, formatMercariUserAgent } from "./endpoints";
import { getMercariAccessToken } from "./tokenAccess";
import { CREATE_PRODUCT_MUTATION } from "./mutations";
import { assertExternalWriteAllowed } from "@/lib/integrations/writeGuard";
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

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §0-A/§17-A監査
 * (task #25) — 既存のListingDraft/ChannelListing/このアダプタを、
 * §17-Aが要求するMercari Shops側の必須フィールド/依存関係と突き合わせ
 * た結果。この監査で実際に修正した2点(コンディション未設定の黙った
 * フォールバック廃止/variant quantityのInventory実数量化)は上の
 * createMercariProduct本体に反映済み。以下は、監査の結果「今回の
 * ラウンドでは着手しない、設計・実装ともに未着手」と判断した項目 —
 * 隠さずここに明記する(完了報告の残課題として扱う):
 *
 * 1. brandId(ブランド、Mercari側のブランドマスタからの外部ID指定):
 *    lib/listing/mercari/types.tsのCreateProductInputには型としては
 *    既に`brandId?: string | null`が存在するが、送信側(この関数)は
 *    一度も値を設定していない。BELLOのInventory/ListingDraftのどちらに
 *    も「ブランド」という概念のフィールドが現状存在しない — 新設する
 *    にはBELLO側のブランド管理(自由入力か、Mercariのブランドマスタを
 *    検索して選ぶUIか)の設計そのものから必要で、Option Profile
 *    (下記2)と並ぶ規模の追加機能になるため、今回は着手しなかった。
 *
 * 2. Option Profile(EcOptionProfile相当のモデル: ラベル名/送料負担者/
 *    配送方法/配送日数/発送元地域/配送設定ID)が丸ごと未実装。現状の
 *    shippingPayerはUI/Server Actionが出品実行のたびに都度渡すだけの
 *    値で永続化されておらず、shippingMethod/shippingFromStateIdは
 *    このファイル冒頭のFALLBACK_*定数へ固定、shippingDurationも
 *    "FOUR_SEVEN_DAYS"へ固定 — 商品ごと/出品者の運用ごとに選べる状態
 *    には程遠い。特に重要な既知の罠(§17-A原文): APIが要求する「配送
 *    設定ID」は、Mercari自身のUIに表示される人間向けの「送料ID（任意）」
 *    ラベルとは別物で、実際のIDは配送設定の編集画面URLの
 *    `/`と`/edit`の間のセグメントに埋め込まれている、というもの —
 *    これはOption Profile機能そのものが無い今は該当箇所が無いため
 *    UI文言化もできていない。将来Option Profileを実装する際は、その
 *    入力欄のヘルプテキストに必ずこの罠を明記すること。
 *
 * 3. variant構造のSKU/JAN(任意項目): lib/listing/mercari/types.tsの
 *    MercariProductVariantInputには`janCode`フィールドが既にあるが、
 *    この関数は一度も設定していない(BELLO側にJANコードを保持する
 *    フィールドはInventory.barcodeが近いが、これがJANコードそのものか
 *    は別の確認が要る — 誤って無関係の値を送るくらいなら未設定のまま
 *    にする、という判断)。variantのname相当のフィールドも
 *    CreateProductInput自体に無く、実Schema未確認のまま追加するのは
 *    リスクが高いため見送った。
 *
 * 4. 「配送方法/配送元地域を商品ごとに選択可能にする」
 *    (このファイル従来のコメントが将来対応として言及していた内容)は
 *    上記2のOption Profileが実装されて初めて意味を持つため、これも
 *    未着手。
 *
 * これら4点は、いずれも新しいモデル/UI設計を要する規模の追加機能で
 * あり、「検証できないものを不確かなまま出荷しない」という今回の
 * ラウンド全体の方針、および実Mercari Schemaへ到達する手段がこの
 * sandbox環境に無いという制約から、今回は意図的に着手を見送った —
 * 完了報告の残課題として明記する。
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
  /**
   * BELLO統合改修 master指示書(2026-08-29統合改修版) §17-A: variant構造
   * のquantityは「Inventory側の在庫数量から導出」が必須要件 — 呼び出し
   * 元(lib/listing/service.tsのlistOnMercari)が出品実行の直前に
   * Inventoryを再取得し、その時点のquantityをここへ渡す(ListingDraft
   * 自体には保存しない — 在庫数量は常にInventoryが単一の真実の情報源
   * であり、下書き保存時点の値をコピーして古くなるのを避けるため)。
   */
  inventoryQuantity: number;
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
  const { draft, channelListing, shippingPayer, inventoryQuantity } = input;

  if (!channelListing.categoryMapping?.mercariCategoryId) {
    throw new Error("Mercariのカテゴリーが未設定です。末端カテゴリーを選択してください。");
  }
  if (draft.images.length === 0) {
    throw new Error("画像が1枚も登録されていません。出品するにはInventory側に少なくとも1枚の画像が必要です。");
  }
  // BELLO統合改修 master指示書(2026-08-29統合改修版) §17-A: コンディ
  // ションが未設定のまま実在のMercari APIへ「目立った傷や汚れなし」等
  // を黙って送るのは、ユーザーが選んでいない値を実出品してしまう
  // ことになり、Q16/Q17が禁止する「エラーを握り潰して成功したふりを
  // する」の変種にあたる — 以前はdraft.condition ?? "NO_NOTABLE_DAMAGE"
  // で黙ってフォールバックしていたが、CONFIG_REQUIREDとして明示的に
  // ブロックするよう修正した(未マッピングを"new"へ黙ってフォールバッ
  // クしてはならない、という同じ原則の適用)。
  if (!draft.condition) {
    throw new Error("商品の状態（コンディション）が未設定です。出品下書き編集画面でコンディションを選択してから出品してください。");
  }
  // BELLO統合改修 master指示書(2026-08-29統合改修版) §17-A: variant
  // 構造のquantityは「Inventory側の在庫数量から導出」が必須要件 —
  // 数量0(在庫切れ)のまま出品すると実際に売れない商品を公開してしまう
  // ため、これも明示的にブロックする。
  if (inventoryQuantity <= 0) {
    throw new Error("在庫数量が0です。出品するには在庫数量を1以上に設定してください。");
  }

  const effective = resolveEffectiveListingFields(draft, channelListing);
  const images = await Promise.all(
    [...draft.images]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(async (img, idx) => ({ url: await resolveImageUrlForMercari(img.storageKey), sortOrder: idx })),
  );

  const apiInput: CreateProductInput = {
    name: effective.title,
    description: effective.description,
    price: effective.price,
    categoryId: channelListing.categoryMapping.mercariCategoryId,
    condition: conditionToMercariValue(draft.condition),
    images,
    shippingPayer: shippingPayerToMercariValue(shippingPayer),
    // [UNVERIFIED] 配送方法/配送元地域はBELLOにまだ商品ごとの設定項目が
    // 無いため固定フォールバック — adapter.tsファイル冒頭コメント参照。
    shippingMethod: FALLBACK_SHIPPING_METHOD,
    shippingDuration: shippingDurationToMercariValue("FOUR_SEVEN_DAYS"),
    shippingFromStateId: FALLBACK_SHIPPING_FROM_STATE_ID,
    status: internalStatusToMercariApiStatus(channelListing.status),
    // stockQuantityはInventory側の実在庫数量から導出する(§17-A必須要件
    // — 以前はハードコードされた1固定値だった)。
    variants: [{ skuCode: draft.inventoryId, stockQuantity: inventoryQuantity }],
  };

  // Mercariへ実際に商品を作る唯一の呼び出し。ここより手前の
  // バリデーションや画像URLの解決は相手のデータを変えないので、
  // 関門は送信の直前に置く（新しい経路が増えても素通りしないように）。
  assertExternalWriteAllowed("MERCARI_SHOPS", "createProduct");

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
 * 指定したTOKEN・APIクライアント名で実際にMercari Shops APIへ疎通でき
 * るかを確認する(app/actions/zaicoSecret.tsのvalidateZaicoTokenと同じ
 * 「保存前に検証する」パターン)。渡された値だけを使い、Secrets
 * Manager/環境変数に既に保存されている値には一切触れない — 保存が
 * 確定する前の検証専用(BELLO統合業務OS指示書 2026-08-30 §92: 「新token
 * 検証失敗時に既存の有効設定を破壊しない」)。
 *
 * clientNameを引数で受け取れるようにしたのは§24の要件(設定画面から
 * APIクライアント名も入力・保存できるようにする)対応 — 検証時点では
 * まだSecrets Managerに保存されていない入力中の値でUser-Agentを組み立
 * てる必要があるため、lib/listing/mercari/client.tsのMercariShopsClient
 * が受け付けるようになったgetUserAgent注入を使う。
 */
export async function validateMercariConnection(params: {
  token: string;
  clientName: string;
  clientVersion?: string;
}): Promise<{ ok: boolean; message: string; code?: MercariErrorCode }> {
  const environment = getMercariEnvironment();
  const testClient = new MercariShopsClient({
    environment,
    getAccessToken: async () => params.token,
    getUserAgent: async () => formatMercariUserAgent(params.clientName, params.clientVersion),
  });
  try {
    await testClient.request<ProductCategoriesResponse>(PRODUCT_CATEGORIES_QUERY, {}, { disableRetry: true });
    return { ok: true, message: `Mercari Shops API（${environment}）への接続を確認しました。` };
  } catch (err) {
    if (err instanceof MercariApiError) {
      return { ok: false, message: `Mercari Shops APIへの接続に失敗しました: ${err.message}`, code: err.code };
    }
    const message = err instanceof Error ? err.message : "不明なエラー";
    return { ok: false, message: `Mercari Shops APIへの接続に失敗しました: ${message}` };
  }
}

export { MercariApiError };
