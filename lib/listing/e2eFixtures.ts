/**
 * EC一覧P1 レビュー補正(2026-09-13)専用のPlaywright E2E fixture。
 *
 * 【なぜ必要か】lib/inventory/e2eFixtures.ts と同じ理由 —
 * このsandbox環境には実AWS(AppSync)への到達経路が無く、
 * listListingsOverview はCategory/Inventory(GSI)/ChannelListing/
 * ListingDraft の4本を実際に呼ぶため、そのままではE2Eで
 * `INVENTORY_E2E_FIXTURES=1` を立てても失敗する(listListingsOverviewSafe
 * が`{ok:false, failure}`へ落とすので一覧はerror状態になり、364件描画・
 * 検索・絞込・ページ移動・選択維持を実ブラウザで検証できない)。
 *
 * 【安全設計】lib/inventory/e2eFixtures.ts と同じ二重ゲート
 * (isE2EFixtureModeActive — NODE_ENV!=='production' かつ
 * INVENTORY_E2E_FIXTURES==='1')の**内側**でのみ呼ばれる
 * (呼び出し元: lib/listing/service.ts の listListingsOverview 冒頭)。
 * 書き込み系には一切関与しない(読み取り一覧の表示検証専用)。
 *
 * 【件数・構成】364件(タスク指示書§7「実React一覧364件以上」に対応):
 *   - 先頭20件: channelListing無し・hasDraft=false → NOT_STARTED
 *     (一括下書き作成の対象になり得る行)
 *   - 次の20件: channelListing無し・hasDraft=true → DRAFT
 *     (既に下書きがあるので一括作成の対象から除外される行 —
 *     selectableInventoryIdsの検証に使う)
 *   - 残り324件: ListingStatusの12値を27件ずつ均等に割り当てた
 *     channelListingを持つ行(状態絞り込みの各バケットに複数件を保証する)。
 * 先頭1件(index 0)には検索テスト用の一意な名前を付けてある。
 */
import type { ListingOverviewRow } from "./service";
import type { ChannelListingRecord, ListingChannel, ListingDraftRecord, ListingStatus, MercariCategoryMapping } from "./types";
import { DEFAULT_LISTING_SHIPPING_METHOD } from "./types";

const ALL_STATUSES: ListingStatus[] = [
  "NOT_PREPARED",
  "DRAFT",
  "READY",
  "QUEUED",
  "PUBLISHING",
  "ACTIVE",
  "PAUSED",
  "SOLD",
  "ENDED",
  "RELIST_PENDING",
  "ERROR",
  "ARCHIVED",
];

const NOW = "2026-09-01T00:00:00.000Z";

function makeChannelListing(inventoryId: string, status: ListingStatus): ChannelListingRecord {
  return {
    id: `e2e-cl-${inventoryId}`,
    listingDraftId: `e2e-ld-${inventoryId}`,
    inventoryId,
    channel: "MERCARI_SHOPS",
    categoryMapping: null,
    overrideTitle: null,
    overrideDescription: null,
    overridePrice: null,
    status,
    externalListingId: status === "ACTIVE" || status === "SOLD" ? `ext-${inventoryId}` : null,
    listingUrl: null,
    firstListedAt: null,
    lastListedAt: null,
    lastRelistedAt: null,
    endedAt: null,
    soldAt: null,
    lastError: null,
    autoPricingEnabled: false,
    pricingRuleId: null,
    originalPrice: null,
    currentPrice: null,
    floorPrice: null,
    markdownCount: 0,
    lastPriceChangeAt: null,
    nextPriceActionAt: null,
    automationHold: false,
    lastAutomationResult: null,
    shippingRank: null,
    shippingDestinationPrefecture: null,
    calculatedShippingFee: null,
    confirmedShippingFee: null,
    shippingFeeUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeRow(i: number, overrides: Partial<ListingOverviewRow> = {}): ListingOverviewRow {
  const id = `e2e-listing-${i}`;
  return {
    inventoryId: id,
    displayId: `E2E-${String(i).padStart(4, "0")}`,
    name: `E2Eテスト出品-${i}`,
    quantity: 1,
    price: 1000 + i,
    thumbnailKey: null,
    inventoryUpdatedAt: NOW,
    hasDraft: false,
    channelListing: null,
    ...overrides,
  };
}

const TOTAL_ROWS = 364;
const NOT_STARTED_COUNT = 20;
const DRAFT_COUNT = 20;

/**
 * task_e8b97d6b40aad90fff(2026-09-15): 商品数上限超過検証専用の21件目
 * (index===40)のid。一覧(/inventory/listings)のCSVモードから選択できる
 * 唯一の行として、「単品ページで編集→保存→一覧のCSV生成ボタンを実際に
 * 押して実downloadしたCSVの中身が編集値と一致する」検証にも流用する
 * (下のe2eMercariCsvListingDraftの分岐参照)。
 */
export const E2E_LISTINGS_OVERVIEW_BULK_ROW_ID = `e2e-listing-${NOT_STARTED_COUNT + DRAFT_COUNT}`;

function buildRows(): ListingOverviewRow[] {
  const rows: ListingOverviewRow[] = [];
  for (let i = 0; i < NOT_STARTED_COUNT; i++) {
    rows.push(makeRow(i, { hasDraft: false, channelListing: null }));
  }
  for (let i = NOT_STARTED_COUNT; i < NOT_STARTED_COUNT + DRAFT_COUNT; i++) {
    rows.push(makeRow(i, { hasDraft: true, channelListing: null }));
  }
  let statusIndex = 0;
  for (let i = NOT_STARTED_COUNT + DRAFT_COUNT; i < TOTAL_ROWS; i++) {
    const status = ALL_STATUSES[statusIndex % ALL_STATUSES.length];
    statusIndex++;
    const overrides: Partial<ListingOverviewRow> = { channelListing: makeChannelListing(`e2e-listing-${i}`, status) };
    // Mercari CSV画像受渡しE2E(2026-09-14レビュー修正)専用: 一覧のCSV
    // モード「すべて選択」でMAX_ZIP_PRODUCTS(=20、lib/listing/mercari/
    // csv/imageBundle.ts)を実際に超える21件目を作るため、この1行
    // (index===40、ステータスは"NOT_PREPARED"のまま)だけhasDraft:trueを
    // 足す。表示ステータス(statusOf()の分岐、"未準備"バケット)は変えて
    // いない——csvExportEligibleInventoryIds(hasDraftのみで判定)だけが
    // この行を対象に含めるようになる。e2e/listings-overview.spec.tsの
    // 「下書き」バケット件数(DRAFT_COUNT+27)・総件数(364)には影響しない
    // (この行のstatusOf()は"NOT_PREPARED"のまま)。
    if (`e2e-listing-${i}` === E2E_LISTINGS_OVERVIEW_BULK_ROW_ID) overrides.hasDraft = true;
    rows.push(makeRow(i, overrides));
  }
  // 検索テスト用: 一意な名前を持つ1件を先頭に混ぜる(既存のNOT_STARTED行を上書き)。
  rows[0] = makeRow(0, { name: "検索対象サンプルチェアA", hasDraft: false, channelListing: null });
  return rows;
}

const E2E_LISTINGS_OVERVIEW_ROWS: ListingOverviewRow[] = buildRows();

/**
 * 呼び出し回数で挙動を変える(Playwrightの単一共有dev serverプロセス内で
 * 「初回は失敗、再試行(reload/retryボタン)で成功」を決定的に再現する —
 * lib/inventory/e2eFixtures.ts の e2e-inv-8(historyFailOnceCounts)と
 * 同じ発想)。
 *
 * 【実測で踏んだ罠】素朴なmodule-scopeの`let callCount`だと壊れる——
 * Next.js devモードは、この一覧の初回取得(Server Component/RSC層)と
 * 再試行(app/actions/listing.tsのServer Action層)を**別々のwebpack
 * モジュールインスタンス**としてコンパイルする(実際にサーバーログで
 * `callCount===1`が2回とも真になるのを確認した——RSC層側の`let`と
 * Server Action層側の`let`が別モノになっている)。同じNode.jsプロセス内
 * では常に1つである`globalThis`をカウンタの置き場にすることで、
 * どちらの層から呼ばれても同じ値を共有させる。
 *
 * 1回目: reject(read rejectionからの局所復帰を検証)。
 * 2回目以降: 実際のGSI Query + Scan往復を模した5秒遅延の後、364件を返す
 * (ヘッダー・検索欄が取得完了を待たずに表示されることを検証)。
 */
const CALL_COUNT_KEY = Symbol.for("bello.e2eListingsOverviewFetch.callCount");
type GlobalWithCallCount = typeof globalThis & { [CALL_COUNT_KEY]?: number };

export async function e2eListingsOverviewFetch(): Promise<ListingOverviewRow[]> {
  const g = globalThis as GlobalWithCallCount;
  const callCount = (g[CALL_COUNT_KEY] ?? 0) + 1;
  g[CALL_COUNT_KEY] = callCount;
  if (callCount === 1) {
    throw new Error("[e2e-fixture] simulated listListingsOverview transient failure (recovers on retry)");
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return E2E_LISTINGS_OVERVIEW_ROWS;
}

/**
 * 2026-09-14 指示書レビュー修正: EC出品個別編集画面(app/inventory/
 * (protected)/[id]/listing/ListingForm.tsx)の「出品内容をコピー
 * （手動出品用）」ボタン・AutoPricingSectionのmanual-only注記は、
 * どちらも「下書き(ListingDraft)とChannelListing(MERCARI_SHOPS)が
 * 既に存在する」商品でしか描画されない(ボタンは`disabled={!draft}`、
 * AutoPricingSectionは`{channelListing && (...)}`)。
 *
 * 従来のlib/listing/service.tsのgetListingDraftForInventory/
 * getChannelListingは、fixtureモードでは商品を問わず常にnullを返して
 * いた(第六ラウンドP0-1)——一覧・画像等の既存E2Eには十分だったが、
 * このボタン・セクション自体を実ブラウザでクリックして確かめる経路が
 * 無かった。lib/inventory/e2eFixtures.tsに専用に追加したe2e-inv-30
 * だけ、この2つの合成レコードを返す(他のidは従来通りnull——既存の
 * listing-layout.spec.ts等はe2e-inv-1を使っており挙動は変えない)。
 */
export const E2E_MANUAL_ONLY_INVENTORY_ID = "e2e-inv-30";

const E2E_MANUAL_ONLY_NOW = "2026-09-14T00:00:00.000Z";

export function e2eManualOnlyListingDraft(): ListingDraftRecord {
  return {
    id: "e2e-fixture-ld-30",
    inventoryId: E2E_MANUAL_ONLY_INVENTORY_ID,
    title: "【E2Eテスト】北欧デザインダイニングチェア ウォールナット材 30号",
    description: "手動出品支援の実ブラウザ検証専用の合成下書き説明文です。",
    price: 27800,
    condition: "NO_NOTABLE_DAMAGE",
    shippingMethod: DEFAULT_LISTING_SHIPPING_METHOD,
    images: [],
    createdBy: "e2e-fixture",
    updatedBy: "e2e-fixture",
    createdAt: E2E_MANUAL_ONLY_NOW,
    updatedAt: E2E_MANUAL_ONLY_NOW,
  };
}

export function e2eManualOnlyChannelListing(): ChannelListingRecord {
  return {
    id: "e2e-fixture-cl-30",
    listingDraftId: "e2e-fixture-ld-30",
    inventoryId: E2E_MANUAL_ONLY_INVENTORY_ID,
    channel: "MERCARI_SHOPS",
    categoryMapping: null,
    overrideTitle: null,
    overrideDescription: null,
    overridePrice: null,
    status: "DRAFT",
    externalListingId: null,
    listingUrl: null,
    firstListedAt: null,
    lastListedAt: null,
    lastRelistedAt: null,
    endedAt: null,
    soldAt: null,
    lastError: null,
    autoPricingEnabled: false,
    pricingRuleId: null,
    originalPrice: null,
    currentPrice: null,
    floorPrice: null,
    markdownCount: 0,
    lastPriceChangeAt: null,
    nextPriceActionAt: null,
    automationHold: false,
    lastAutomationResult: null,
    shippingRank: null,
    shippingDestinationPrefecture: null,
    calculatedShippingFee: null,
    confirmedShippingFee: null,
    shippingFeeUpdatedAt: null,
    createdAt: E2E_MANUAL_ONLY_NOW,
    updatedAt: E2E_MANUAL_ONLY_NOW,
  };
}

/**
 * Mercari CSV画像受渡し(2026-09-14レビュー修正)専用のE2Eフィクスチャ群。
 *
 * scripts/generate-sample-mercari-export.tsが使っているのと同じ実在の
 * カテゴリーID(data/mercari-masters/category_master.csvに実在——
 * scripts/verify-mercari-csv-export.tsの「getCategoryById resolves a
 * known real categoryId」で検証済み)をそのまま使う——存在しないIDを
 * 捏造しない、という指示書の方針をE2Eフィクスチャでも守る。
 * shippingPayer=1(送料込)を使う理由も同じ理由(generate-sample-
 * mercari-export.tsのコメント参照——shippingFeeIdマスタが提供されて
 * いないため送料別は常にブロックされる、既知の残課題)。
 *
 * storageKeyは全て`e2e-mercari-img:`接頭辞(lib/listing/mercari/csv/
 * e2eImageFixtureBytes.ts) — getInventoryImageDownloadUrl
 * (buildExportRows.ts)がこの接頭辞だけをローカルのe2e-fixtures配信
 * route(実HTTP、実AWS不要)へ差し替える。
 */
const E2E_MERCARI_KNOWN_CATEGORY_ID = "iBDxa3BbcUz8XWrr5pgq2Z";
const E2E_MERCARI_KNOWN_CATEGORY_NAME = "CD・DVD・ブルーレイ > CD > K-POP・アジア";

function e2eMercariCategoryMapping(): NonNullable<ChannelListingRecord["categoryMapping"]> {
  return {
    mercariCategoryId: E2E_MERCARI_KNOWN_CATEGORY_ID,
    mercariCategoryName: E2E_MERCARI_KNOWN_CATEGORY_NAME,
    mercariShippingDays: 2,
    mercariShippingPayer: 1,
  };
}

/** 単品ページ(/inventory/[id]/listing)向け: 1枚画像・CSV生成も通る完全合成商品(正常系の通し合成E2E)。 */
export const E2E_MERCARI_ZIP_SINGLE_ID = "e2e-inv-41";
/** MAX_ZIP_IMAGES(=100、imageBundle.ts)を1枚超える101枚——reject側の境界。 */
export const E2E_MERCARI_ZIP_OVERFLOW_ID = "e2e-inv-42";
/** 画像取得が期限切れ相当(403)で失敗する。 */
export const E2E_MERCARI_ZIP_EXPIRED_ID = "e2e-inv-43";
/** 画像取得が権限なし相当(403)で失敗する。 */
export const E2E_MERCARI_ZIP_FORBIDDEN_ID = "e2e-inv-44";
/** 画像取得が対象なし相当(404、削除済み/不正キー)で失敗する。 */
export const E2E_MERCARI_ZIP_MISSING_ID = "e2e-inv-45";
/** MAX_ZIP_IMAGES(=100)ちょうど——accept側の境界。 */
export const E2E_MERCARI_ZIP_BOUNDARY_OK_ID = "e2e-inv-46";
/** MAX_ZIP_FILE_BYTES(=15MB、imageTransferLimits.ts)を超える1枚(16MB)——ブラウザ側のストリーム受信中打ち切りを実ブラウザで検証する(task_f712cf24a9fe2308cd、2026-09-14是正)。 */
export const E2E_MERCARI_ZIP_TOO_LARGE_ID = "e2e-inv-47";

/**
 * 一覧ページ(/inventory/listings)のCSVモード「すべて選択」で実際に
 * チェックが入る20商品(lib/listing/e2eFixtures.tsのbuildRows()内、
 * index===40の1行だけ意図的にhasDraft:trueを足してMAX_ZIP_PRODUCTS
 * (=20)超過の21件目を作ってある——そちらはここには含めない=下書き
 * 自体を持たせない(getListingDraftForInventoryがnullを返す)ことで、
 * MAX_ZIP_PRODUCTSの判定(inventoryIds.length>MAX_ZIP_PRODUCTS、
 * app/actions/listing.tsのgetMercariCsvImageZipAction冒頭)が個別商品
 * 解決より先に効くことを確かめる——21件目に有効なデータを用意する
 * 必要が無い、という事実そのものがその判定順序の証拠になる)。
 */
export const E2E_MERCARI_ZIP_BULK_IDS: string[] = Array.from({ length: 20 }, (_, i) => `e2e-listing-${20 + i}`);

function e2eMercariCsvDraft(inventoryId: string, images: { storageKey: string }[]): ListingDraftRecord {
  return {
    id: `e2e-fixture-ld-${inventoryId}`,
    inventoryId,
    title: `【E2Eテスト】Mercari CSV画像受渡し検証商品 ${inventoryId}`,
    description: "画像まとめダウンロード(ZIP)の実ブラウザ検証専用の合成下書き説明文です。",
    price: 9800,
    condition: "NO_NOTABLE_DAMAGE",
    shippingMethod: DEFAULT_LISTING_SHIPPING_METHOD,
    images: images.map((img, idx) => ({ storageKey: img.storageKey, sortOrder: idx })),
    createdBy: "e2e-fixture",
    updatedBy: "e2e-fixture",
    createdAt: E2E_MANUAL_ONLY_NOW,
    updatedAt: E2E_MANUAL_ONLY_NOW,
  };
}

function e2eMercariCsvChannelListing(inventoryId: string): ChannelListingRecord {
  return { ...e2eManualOnlyChannelListing(), id: `e2e-fixture-cl-${inventoryId}`, listingDraftId: `e2e-fixture-ld-${inventoryId}`, inventoryId, categoryMapping: e2eMercariCategoryMapping() };
}

/** getListingDraftForInventory(service.ts)のMercari CSV画像E2E分岐。該当しないidはnull(呼び出し側が従来通り処理する)。 */
export function e2eMercariCsvListingDraft(inventoryId: string): ListingDraftRecord | null {
  if (inventoryId === E2E_MERCARI_ZIP_SINGLE_ID) {
    return e2eMercariCsvDraft(inventoryId, [{ storageKey: "e2e-mercari-img:ok-1" }]);
  }
  if (inventoryId === E2E_MERCARI_ZIP_OVERFLOW_ID) {
    return e2eMercariCsvDraft(
      inventoryId,
      Array.from({ length: 101 }, (_, i) => ({ storageKey: `e2e-mercari-img:ok-${i + 1}` })),
    );
  }
  if (inventoryId === E2E_MERCARI_ZIP_BOUNDARY_OK_ID) {
    return e2eMercariCsvDraft(
      inventoryId,
      Array.from({ length: 100 }, (_, i) => ({ storageKey: `e2e-mercari-img:ok-${i + 1}` })),
    );
  }
  if (inventoryId === E2E_MERCARI_ZIP_EXPIRED_ID) {
    return e2eMercariCsvDraft(inventoryId, [{ storageKey: "e2e-mercari-img:expired" }]);
  }
  if (inventoryId === E2E_MERCARI_ZIP_FORBIDDEN_ID) {
    return e2eMercariCsvDraft(inventoryId, [{ storageKey: "e2e-mercari-img:forbidden" }]);
  }
  if (inventoryId === E2E_MERCARI_ZIP_MISSING_ID) {
    return e2eMercariCsvDraft(inventoryId, [{ storageKey: "e2e-mercari-img:missing" }]);
  }
  if (inventoryId === E2E_MERCARI_ZIP_TOO_LARGE_ID) {
    return e2eMercariCsvDraft(inventoryId, [{ storageKey: "e2e-mercari-img:toolarge" }]);
  }
  if (E2E_MERCARI_ZIP_BULK_IDS.includes(inventoryId)) {
    return e2eMercariCsvDraft(inventoryId, [{ storageKey: "e2e-mercari-img:ok-1" }]);
  }
  if (
    inventoryId === E2E_MERCARI_CSV_EDIT_ID ||
    inventoryId === E2E_MERCARI_CSV_SAVE_FAIL_ID ||
    inventoryId === E2E_MERCARI_FURNITURE_PICKER_ID ||
    inventoryId === E2E_MERCARI_FURNITURE_SEARCH_ID ||
    inventoryId === E2E_MERCARI_CSV_SHIPPING_EXTRAS_ID
  ) {
    return e2eMercariCsvDraft(inventoryId, [{ storageKey: "e2e-mercari-img:ok-1" }]);
  }
  // task_e8b97d6b40aad90fff(2026-09-15): E2E_MERCARI_CSV_EDIT_ID(単品ページ)
  // と同じ「未確定から実UIで埋める」状態を、一覧(/inventory/listings)の
  // CSVモードから選択できる行(E2E_LISTINGS_OVERVIEW_BULK_ROW_ID
  // ="e2e-listing-40"、lib/listing/e2eFixtures.tsのbuildRows()参照)にも
  // 用意する——編集→保存が「一覧のCSV生成ボタンを実際に押して実download
  // したCSVの中身」まで一致することを検証するにはE2E_MERCARI_CSV_EDIT_ID
  // (一覧に出ない個別id)だけでは届かないため。この行は既存のZIP商品数
  // 上限超過検証(index===40)専用で、その検証は選択件数(21件)の時点で
  // 拒否されCSV/画像の中身自体は一切参照しない——ここで実データを持たせ
  // ても既存挙動に影響しない(buildRows()のコメント参照)。
  if (inventoryId === E2E_LISTINGS_OVERVIEW_BULK_ROW_ID) {
    return e2eMercariCsvDraft(inventoryId, [{ storageKey: "e2e-mercari-img:ok-1" }]);
  }
  // (E2E_LISTINGS_OVERVIEW_BULK_ROW_IDはchannelListingを合成しない
  // ——e2eMercariCsvChannelListingForの対象idリストに含めない——ため、
  // getChannelListingは静的fallback=nullを返す=「未確定」から始まる。)
  // 価格不正拒否の検証専用: 下書き価格をMercari CSVの下限(300円、
  // lib/listing/mercari/csv/validate.tsのvalidateMercariCsvRow参照)
  // 未満にしてある——overridePriceは付けない(assembleRow.tsは
  // overridePrice未設定ならdraft.priceをそのまま使う)。
  if (inventoryId === E2E_MERCARI_CSV_INVALID_PRICE_ID) {
    return { ...e2eMercariCsvDraft(inventoryId, [{ storageKey: "e2e-mercari-img:ok-1" }]), price: 100 };
  }
  return null;
}

/** getChannelListing(service.ts)のMercari CSV画像E2E分岐。CSV生成(exportMercariShopsCsvAction)にはcategoryMapping確定が要るため、対象商品には常に完成済みの値を返す。 */
export function e2eMercariCsvChannelListingFor(inventoryId: string): ChannelListingRecord | null {
  if (
    inventoryId === E2E_MERCARI_ZIP_SINGLE_ID ||
    inventoryId === E2E_MERCARI_ZIP_BOUNDARY_OK_ID ||
    E2E_MERCARI_ZIP_BULK_IDS.includes(inventoryId)
  ) {
    return e2eMercariCsvChannelListing(inventoryId);
  }
  // 保存失敗入力保持/価格不正拒否の検証(下記E2E_MERCARI_CSV_SAVE_FAIL_ID/
  // E2E_MERCARI_CSV_INVALID_PRICE_ID)は、どちらもカテゴリー/発送設定が
  // 既に確定済みの状態から始める必要がある(未確定だとUIの発送日数/
  // 配送料負担セレクトがdisabledのまま操作できない、
  // MercariCategoryMappingSection.tsx参照)——そのため他の「完成済み」
  // idと同じ合成カテゴリーマッピングを返す。
  if (inventoryId === E2E_MERCARI_CSV_SAVE_FAIL_ID || inventoryId === E2E_MERCARI_CSV_INVALID_PRICE_ID) {
    return e2eMercariCsvChannelListing(inventoryId);
  }
  // overflow/expired/forbidden/missing、およびE2E_MERCARI_CSV_EDIT_ID
  // (下記、「不足項目をUIで埋める」正常系の検証専用)は、categoryMapping
  // 未確定(null)のまま——CSV生成までは対象にしないか、意図的に未確定
  // 状態から始める。
  return null;
}

/**
 * CSV候補e0fe20760b7a3c2b926f03b58b0c94108b6680fb 不足項目編集→保存→CSV
 * 再生成 通し合成E2E(task_48c715588f96367bc9、2026-09-15)専用。
 *
 * 【なぜ必要か】e2e/mercari-csv-image-download.spec.tsの旧冒頭コメントに
 * 記載していた既知の制約——「CSV編集補完」(カテゴリー/発送日数/配送料
 * 負担の選択・保存UI)はsaveChannelOverrideActionという書き込み経路を
 * 通るため、このsandbox環境(実AWSへの到達経路が無い)では実UIの対話
 * (検索→選択→保存→再読込)自体を検証できず、「保存済み完了状態」を
 * 静的fixtureとして表現するだけに留めていた。
 *
 * lib/listing/service.tsのsaveChannelOverrideに、getListingDraftForInventory
 * /getChannelListingと同じ二重ゲート(isE2EFixtureModeActive)を追加し、
 * その内側だけで動く合成保存状態をここに置く——ドラフト要否判定・
 * カテゴリー対象外判定・(新設の)入力値検証は本番と全く同じコードを
 * 通った"後"にここへ来る(検証ロジック自体の二重実装ではない、
 * service.tsのsaveChannelOverrideコメント参照)。書き込みはこの
 * プロセス内のMapに留まり、実DynamoDBへは一切到達しない
 * (scripts/verify-e2e-boundary-spy.tsのe2eReadBoundaryLeaksで実測確認)。
 */
const E2E_CHANNEL_OVERRIDE_STORE_KEY = Symbol.for("bello.e2eChannelOverrideStore");
type GlobalWithChannelOverrideStore = typeof globalThis & { [E2E_CHANNEL_OVERRIDE_STORE_KEY]?: Map<string, ChannelListingRecord> };

/**
 * task_e8b97d6b40aad90fff(2026-09-15)是正: 元の実装は`inventoryId`だけを
 * キーにしていた——同じinventoryIdへ異なるchannel(MERCARI_SHOPS/BASE、
 * 例: app/actions/listing.tsのsaveChannelOverrideAction/
 * saveBaseChannelOverrideActionは同じinventoryIdへ違うchannelで
 * saveChannelOverrideを呼ぶ)で保存すると、後勝ちで前のchannelの合成
 * レコードを丸ごと上書きしてしまい、getChannelListingが別channelの
 * 値を誤って返す(BASE保存がMERCARI_SHOPSの保存を破壊する/その逆)。
 * `channel`もキーに含めて分離する。
 */
function channelOverrideKey(inventoryId: string, channel: ListingChannel): string {
  return `${channel}:${inventoryId}`;
}

function e2eChannelOverrideStore(): Map<string, ChannelListingRecord> {
  const g = globalThis as GlobalWithChannelOverrideStore;
  if (!g[E2E_CHANNEL_OVERRIDE_STORE_KEY]) g[E2E_CHANNEL_OVERRIDE_STORE_KEY] = new Map();
  return g[E2E_CHANNEL_OVERRIDE_STORE_KEY]!;
}

/** 単品ページ(/inventory/e2e-inv-48/listing)向け: カテゴリー/発送日数/配送料負担が未確定の状態から始め、実UIで埋めて保存→再読込→CSV再生成まで通す正常系。 */
export const E2E_MERCARI_CSV_EDIT_ID = "e2e-inv-48";
/** 保存が常に失敗する(実運用の保存障害を模す)——保存失敗時に入力(選択中の値)が消えないことの検証専用。 */
export const E2E_MERCARI_CSV_SAVE_FAIL_ID = "e2e-inv-49";
/** カテゴリー/発送設定は確定済みだが下書き価格が300円未満(不正値)——CSV生成時の価格不正拒否の検証専用。 */
export const E2E_MERCARI_CSV_INVALID_PRICE_ID = "e2e-inv-50";
/**
 * 家具店向け効率化指示書(2026-09-15)是正 §7-1/2/6専用
 * (task_302c7e3c24b575629d): 8入口ナビゲータ
 * (MercariFurnitureCategoryPicker.tsx)自体の実ブラウザ検証(8入口表示→
 * ドリルダウン→パンくず→決定ボタンの活性/非活性→再読込復元)は、
 * E2E_MERCARI_CSV_EDIT_ID(e2e-inv-48)を使う既存spec
 * (mercari-csv-edit-save.spec.ts)が既にこのidのcategoryMappingを
 * process内Map(e2eChannelOverrideStore)へ保存済みにしうるため共有
 * できない——専用の未確定id(下書きあり・categoryMapping未設定)を
 * 別途用意する。
 */
export const E2E_MERCARI_FURNITURE_PICKER_ID = "e2e-inv-51";
/** 家具内検索(task_302c7e3c24b575629d §4-D是正)専用。上のE2E_MERCARI_FURNITURE_PICKER_IDはドリルダウン保存テストが実際に保存まで行うため共有できない(コメント参照)。 */
export const E2E_MERCARI_FURNITURE_SEARCH_ID = "e2e-inv-52";
/**
 * 発送元/配送方法/CSV公開設定の独立保存(task_1d6008f0c4f2ef3468、
 * 2026-09-15是正)専用。E2E_MERCARI_CSV_EDIT_ID(e2e-inv-48)と同じく
 * カテゴリー/発送日数/配送料負担/発送元/配送方法/CSV公開設定すべて
 * 未確定から始めるが、48番は既存のカテゴリー/発送日数/配送料負担の
 * 保存順序を検証する専用specの本題を持つため、新規3項目の保存順序
 * (発送元→配送方法→CSV公開設定→カテゴリー後付け、および逆順)の
 * 検証で同じidを使うとテスト同士の保存済み状態が混ざる——分離する。
 */
export const E2E_MERCARI_CSV_SHIPPING_EXTRAS_ID = "e2e-inv-53";

/** getChannelListing(service.ts)のE2E分岐から呼ぶ。合成保存済みの値があればそれを優先し、無ければ従来通りの静的fallback(またはnull)を返す——既存id(E2E_MANUAL_ONLY_INVENTORY_ID等)は一度も保存されないため、常にfallbackがそのまま返り挙動は変わらない。channelもキーに含める(上のchannelOverrideKey参照——別channelの保存を誤って返さない)。 */
export function e2eChannelOverrideFor(inventoryId: string, channel: ListingChannel, fallback: ChannelListingRecord | null): ChannelListingRecord | null {
  return e2eChannelOverrideStore().get(channelOverrideKey(inventoryId, channel)) ?? fallback;
}

/**
 * saveChannelOverride(service.ts)のE2E分岐から呼ぶ。実DynamoDBの
 * create/updateの代わりにプロセス内Mapへ書く以外は、既存(あれば)を
 * 引き継ぐか新規作成するかの分岐・フィールド構成を本番と同じ形にする。
 *
 * `existing`は呼び出し元(service.ts)が既に`getChannelListing`(=上の
 * e2eChannelOverrideFor経由)で解決した値をそのまま渡す——ここで再度
 * 引かない(二重の解決経路を作らない)。
 */
export function e2eSaveChannelOverride(
  inventoryId: string,
  channel: ListingChannel,
  input: { categoryMapping: MercariCategoryMapping | null; overrideTitle: string | null; overrideDescription: string | null; overridePrice: number | null },
  who: string | null,
  existing: ChannelListingRecord | null,
): ChannelListingRecord {
  // 保存失敗入力保持の実UI検証専用: 毎回必ず失敗する——Mapへは一切
  // 書き込まない(前回保存済みの値のまま変わらない)ことがポイント。
  if (inventoryId === E2E_MERCARI_CSV_SAVE_FAIL_ID) {
    throw new Error("[e2e-fixture] simulated saveChannelOverride failure (input is not persisted)");
  }
  const now = new Date().toISOString();
  const record: ChannelListingRecord = existing
    ? {
        ...existing,
        categoryMapping: input.categoryMapping,
        overrideTitle: input.overrideTitle,
        overrideDescription: input.overrideDescription,
        overridePrice: input.overridePrice,
        updatedAt: now,
      }
    : {
        id: `e2e-fixture-cl-${inventoryId}`,
        listingDraftId: `e2e-fixture-ld-${inventoryId}`,
        inventoryId,
        channel,
        categoryMapping: input.categoryMapping,
        overrideTitle: input.overrideTitle,
        overrideDescription: input.overrideDescription,
        overridePrice: input.overridePrice,
        status: "DRAFT",
        externalListingId: null,
        listingUrl: null,
        firstListedAt: null,
        lastListedAt: null,
        lastRelistedAt: null,
        endedAt: null,
        soldAt: null,
        lastError: null,
        autoPricingEnabled: false,
        pricingRuleId: null,
        originalPrice: null,
        currentPrice: null,
        floorPrice: null,
        markdownCount: 0,
        lastPriceChangeAt: null,
        nextPriceActionAt: null,
        automationHold: false,
        lastAutomationResult: null,
        shippingRank: null,
        shippingDestinationPrefecture: null,
        calculatedShippingFee: null,
        confirmedShippingFee: null,
        shippingFeeUpdatedAt: null,
        createdAt: now,
        updatedAt: now,
      };
  e2eChannelOverrideStore().set(channelOverrideKey(inventoryId, channel), record);
  return record;
}
