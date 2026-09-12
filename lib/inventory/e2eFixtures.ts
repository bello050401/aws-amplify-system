/**
 * BELLO統合業務OS 第五ラウンド §7/P1-A: Playwright E2Eテスト専用の
 * 固定fixtureデータ。
 *
 * 【なぜ必要か】このsandbox環境には実AWS(AppSync/Cognito)への到達
 * 経路が無い(amplify_outputs.jsonは`localstub.appsync-api...`という
 * 未デプロイのプレースホルダ——lib/inventory/queries.tsの各関数は
 * 実際にはこのURLへのHTTPS呼び出しを行い、失敗する)。実DBに到達
 * できない以上、実際のページ(app/inventory/(protected)/page.tsx等)を
 * 本物のブラウザで375/390/430px描画してCSS崩れ・横スクロールの
 * 有無を実測するには、DB読み取りだけを差し替える必要がある。
 *
 * 【安全設計】このファイル自体はAWSに一切触れない純粋なデータ定義
 * だが、これを実際に使う側(lib/inventory/queries.tsの各関数)は
 * 二重のゲートで守られている——両方成立しない限り絶対に有効化されない:
 *   1. `process.env.NODE_ENV !== "production"` — AWS Amplify Hostingの
 *      SSRコンピュートは常にNODE_ENV=productionで実行される
 *      (Next.jsの標準挙動、`next start`は常にこれを強制する)。つまり
 *      実際にデプロイされた環境では、環境変数を誤って設定してもこの
 *      分岐は構造的に絶対に通らない。
 *   2. `process.env.INVENTORY_E2E_FIXTURES === "1"` — ローカルの
 *      `npm run test:e2e`だけが設定する明示的なopt-in(amplify.yml・
 *      Amplify Console環境変数のどこにも一切記載しない)。
 * 書き込み系(update/create/delete)には一切のfixture分岐を追加して
 * いない——このE2E harnessは読み取り専用の表示検証のみを目的とする。
 */
export function isE2EFixtureModeActive(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.INVENTORY_E2E_FIXTURES === "1";
}

import type { InventoryListRow, InventoryDetail, InventoryHistoryRow, MasterOption, StatusOption, SearchPage, CustomFieldDefinitionRow } from "./queries";
import type { InventoryImageRecord } from "./imageTypes";

const now = "2026-08-30T09:00:00.000Z";

export const E2E_CATEGORIES: MasterOption[] = [
  { id: "cat-sofa", name: "ソファ", parentId: null, sortOrder: 1 },
  { id: "cat-table", name: "テーブル・デスク", parentId: null, sortOrder: 2 },
  { id: "cat-chair", name: "チェア", parentId: null, sortOrder: 3 },
  { id: "cat-storage", name: "収納家具(キャビネット・棚)", parentId: null, sortOrder: 4 },
  { id: "cat-lighting", name: "照明器具", parentId: null, sortOrder: 5 },
];

export const E2E_LOCATIONS: MasterOption[] = [
  { id: "loc-a1", name: "第一倉庫 Aエリア", parentId: null, sortOrder: 1 },
  { id: "loc-a2", name: "第一倉庫 Bエリア", parentId: null, sortOrder: 2 },
  { id: "loc-b1", name: "第二倉庫", parentId: null, sortOrder: 3 },
];

export const E2E_STATUSES: StatusOption[] = [
  { id: "st-photo", code: "PHOTO_WAIT", label: "撮影待ち", sortOrder: 1 },
  { id: "st-listing", code: "LISTING_WAIT", label: "出品待ち", sortOrder: 2 },
  { id: "st-listed", code: "LISTED", label: "出品中", sortOrder: 3 },
  { id: "st-sold", code: "SOLD", label: "売約済み", sortOrder: 4 },
];

export const E2E_CUSTOM_FIELD_DEFS: CustomFieldDefinitionRow[] = [];

function makeRow(i: number, overrides: Partial<InventoryListRow> = {}): InventoryListRow {
  return {
    id: `e2e-inv-${i}`,
    sku: `B${String(i).padStart(6, "0")}`,
    displayId: `B${String(i).padStart(6, "0")}`,
    sourceSystem: null,
    sourceInventoryId: null,
    name: `【E2Eテスト】北欧デザインダイニングチェア ウォールナット材 ${i}号`,
    categoryId: E2E_CATEGORIES[i % E2E_CATEGORIES.length].id,
    statusId: E2E_STATUSES[i % E2E_STATUSES.length].id,
    locationId: E2E_LOCATIONS[i % E2E_LOCATIONS.length].id,
    quantity: 1,
    unit: "脚",
    purchasePrice: 8000 + i * 100,
    salePrice: null,
    plannedSalePrice: 24800 + i * 100,
    note: "モバイル表示検証用の長めのメモ文字列。テーブル/カードのはみ出しが無いか確認するために意図的に長くしてある。",
    // 画像表示高速化・段階読込 QA是正 — 一覧の全行に合成画像キーを持たせ、
    // InventoryThumbnail(app/inventory/InventoryThumbnail.tsx)の
    // IntersectionObserverによる画面外解決抑制を実ブラウザで検証できる
    // ようにする(以前はnullで「No Image」placeholderのみだったため、
    // 画面外の行が本当に署名解決を遅らせているかを一覧画面では確認
    // できなかった)。全行同じ合成キーを使う——e2e-fixtureキーは
    // useInventoryImageUrl側で意図的にキャッシュされない
    // (常に解決をやり直す)ので、行ごとに独立したイベントとして観測できる。
    mainImageStorageKey: "e2e-fixture:original",
    mainImageThumbnailKey: "e2e-fixture:small",
    createdAt: now,
    updatedAt: now,
    barcode: null,
    saleCommission: null,
    market: null,
    saleStartDate: null,
    saleEndDate: null,
    width: "45",
    depth: "50",
    height: "80",
    conditionRating: "B",
    damageNotes: null,
    transactionDate: null,
    transactionType: null,
    adminMemo: null,
    customFields: null,
    ...overrides,
  };
}

export const E2E_INVENTORY_ROWS: InventoryListRow[] = Array.from({ length: 12 }, (_, i) => makeRow(i + 1));

export function e2eListPage(offset: number, limit: number): SearchPage<InventoryListRow> {
  const items = E2E_INVENTORY_ROWS.slice(offset, offset + limit);
  return { items, total: E2E_INVENTORY_ROWS.length, offset, limit };
}

/**
 * 画像表示高速化・段階読込(P1) QA是正 — 完全合成画像でのCodexブラウザ
 * QA用フィクスチャ。storageKey/thumbnailKey/mediumKeyの`"e2e-fixture:"`
 * 接頭辞はapp/inventory/useInventoryImageUrl.tsが実S3/Cognitoを一切
 * 経由せず解決する専用の合成キー(詳細はそのファイルのコメント参照)。
 * e2e-inv-1〜5だけに実データを持たせ、他の行は従来通りimages:[]。
 */
function e2eFixtureImage(overrides: Pick<InventoryImageRecord, "storageKey"> & Partial<InventoryImageRecord>): InventoryImageRecord {
  return {
    sortOrder: 0,
    type: "NORMAL",
    isPrimary: true,
    sourceSystem: null,
    sourceUrl: null,
    thumbnailKey: null,
    mediumKey: null,
    originalHash: null,
    classification: null,
    ...overrides,
  };
}

const E2E_GALLERY_FIXTURE_IMAGES: Record<string, InventoryImageRecord[]> = {
  // 正常系: small先行表示 → medium(署名+本体とも約1.2秒遅延)へ差し替え、
  // ライトボックスの原本も約0.9秒遅延——小/中/原本の切り替わりが実際の
  // ブラウザで目視できる。
  "e2e-inv-1": [e2eFixtureImage({ storageKey: "e2e-fixture:original-delayed", thumbnailKey: "e2e-fixture:small", mediumKey: "e2e-fixture:medium-delayed" })],
  // medium本体失敗: signは即成功するがURL先のオブジェクトが実在しない
  // (本物の404) → medium onErrorが発火し、smallの表示を維持し続ける。
  "e2e-inv-2": [e2eFixtureImage({ storageKey: "e2e-fixture:original", thumbnailKey: "e2e-fixture:small", mediumKey: "e2e-fixture:medium-broken" })],
  // 原本本体失敗→再試行で回復: ライトボックスを開いた1回目は本体404で
  // 再試行UIが出る。「再試行」を押す(forceRefresh)と2回目以降は成功する。
  "e2e-inv-3": [e2eFixtureImage({ storageKey: "e2e-fixture:original-recovers", thumbnailKey: "e2e-fixture:small", mediumKey: "e2e-fixture:medium-delayed" })],
  // 既存データ互換: thumbnailKey/mediumKeyともnullの旧レコード相当 —
  // effectiveHeroKey/effectiveListThumbnailKeyがstorageKey(原本)へ
  // フォールbackし、表示は壊れない(劣化するのは速度だけ)。
  "e2e-inv-4": [e2eFixtureImage({ storageKey: "e2e-fixture:original" })],
  // 画像切替競合(実React境界)専用: 1枚目はmedium本体が1.2秒遅延、
  // 2枚目はmediumKeyを持たない(small止まり)。1枚目選択直後・medium
  // 到着前に2枚目へ切り替えると、1枚目向けに裏で進んでいたmedium
  // プリロードのonloadが遅れて届く——これがreduceBodyLoadStateの
  // key一致チェックを迂回して2枚目の表示へ誤反映しないことを、
  // 実タイマー・実DOM経由で確認する(app/inventory/
  // inventoryImageLoadState.tsの純粋関数試験とは別に、実際の
  // InventoryImageGallery配線を通した回帰試験として)。2枚目は
  // mediumKey無しなのでsmall.svgのまま変化しないのが正しい——もし
  // 1枚目のmedium.svgへ化けたら競合が再発している。
  // storageKeyはInventoryImageGallery側でReactの`key`にも使われるため、
  // 未知のvariant名(originalへフォールバックする、上のresolveE2E
  // FixtureUrl参照)でも1枚目・2枚目を別の文字列にしてある。
  "e2e-inv-5": [
    e2eFixtureImage({ storageKey: "e2e-fixture:original-switch-a", thumbnailKey: "e2e-fixture:small", mediumKey: "e2e-fixture:medium-delayed", sortOrder: 0, isPrimary: true }),
    e2eFixtureImage({ storageKey: "e2e-fixture:original-switch-b", thumbnailKey: "e2e-fixture:small", mediumKey: null, sortOrder: 1, isPrimary: false }),
  ],
};

export function e2eInventoryDetail(id: string): InventoryDetail | null {
  const row = E2E_INVENTORY_ROWS.find((r) => r.id === id) ?? E2E_INVENTORY_ROWS[0];
  if (!row) return null;
  return {
    ...row,
    // 2026-09-04 EC出品改修指示書 §26: EC出品画面の右パネル(在庫詳細)を
    // 実際に描画して確かめるための値。座面寸法と材質は CustomField 由来で、
    // 実データ(ZAICO「⚪︎座面寸法」「⚪︎材質」)と同じ書き方にしてある。
    // 一覧の行(makeRow)は変更していないので、既存のモバイルE2Eには影響しない。
    customFields: { seatDimensions: "幅46 奥行41 高さ46.5", material: "木材" },
    firstMarkdownPrice: null,
    secondMarkdownPrice: null,
    thirdMarkdownPrice: null,
    externalProductId: null,
    listingNotes: null,
    overallLength: null,
    lengthAdjustable: null,
    mountType: null,
    usedGoodsItemType: null,
    purchaseQuantity: null,
    identityVerificationMethod: null,
    counterpartyName: null,
    counterpartyOccupation: null,
    counterpartyAddress: null,
    shippingCost: null,
    dailyPurchaseTotal: null,
    images: E2E_GALLERY_FIXTURE_IMAGES[row.id] ?? [],
    createdBy: "e2e-fixture",
    updatedBy: "e2e-fixture",
  };
}

/**
 * getInventoryHistory の E2E fixture 版。history は元々 e2eInventoryDetail に
 * 埋め込まれていたが、実装側(queries.ts)がgetInventoryDetail/
 * getInventoryHistoryへ分割されたのに合わせてここも分離——正常系の値は
 * 変更していない。
 *
 * P1後の局所エラー処理レビュー補正(2026-09-12): `INVENTORY_E2E_HISTORY_
 * FAILURE=1` を立てると常に例外を投げる——本体(getInventoryDetail/
 * e2eInventoryDetail)は影響を受けないので、InventoryHistoryTableの
 * エラー表示/再試行導線を実際のReactツリー・Suspense境界を通して
 * ブラウザで確認できる(商品を問わず再現する、読み取り専用の追加
 * opt-in)。既存のe2e-fixtureゲート(isE2EFixtureModeActive、NODE_ENV!==
 * "production" かつ INVENTORY_E2E_FIXTURES==="1")の内側でしか意味を
 * 持たない。
 *
 * 詳細履歴の実境界試験(2026-09-12、task_a748ee69c990317c24)で追加した
 * 商品別シナリオ。E2E_GALLERY_FIXTURE_IMAGES(画像の段階読込QA)と同じ
 * 「特定のidだけに専用の挙動を持たせる」設計に倣う——グローバルな
 * INVENTORY_E2E_HISTORY_FAILURE(商品を問わず常に失敗)とは独立に、
 * 個別のidを行き来しながら本体先行描画・空表示・再試行復帰・別商品への
 * 切替を1つのdevサーバーで作り分けられるようにする:
 *   - e2e-inv-6: 空配列(0件) — 「取得エラー」ではなく正常系の空表示。
 *   - e2e-inv-7: 取得に約2秒の遅延 — 本体(基本情報・画像)がその往復を
 *     待たずに先に描画され、更新履歴だけがSuspense fallback→テーブルの
 *     順で遅れて表示されることを確認する。別商品への切替中に古い応答が
 *     紛れ込まないかの確認にも使う(遅延中に他の商品へ移動する)。
 *   - e2e-inv-8: 直近の失敗回数をこのプロセス内で数え、商品ごとに1回だけ
 *     例外を投げて以降は成功する — SSR初回は失敗表示、再試行ボタンを
 *     押すと成功する回復シナリオを固定手順で再現する(実際のGraphQL
 *     一時障害の代わり)。
 *   - e2e-inv-9: 常に例外を投げる(e2e-inv-8と違い回復しない) —
 *     「失敗表示のまま別商品へ切り替えても、その失敗状態を引きずらない」
 *     ことを確認する用途専用。e2e-inv-8は1回retryすると成功に変わって
 *     しまうため、この確認には使えない(同じdevサーバープロセス内で
 *     状態が変わってしまう)。
 * 上記以外のid(既存のe2e-inv-1等を含む)は元のまま1件の履歴行を返す。
 */
const historyFailOnceCounts = new Map<string, number>();

export async function e2eInventoryHistory(id: string): Promise<InventoryHistoryRow[]> {
  if (process.env.INVENTORY_E2E_HISTORY_FAILURE === "1") {
    throw new Error("[e2e-fixture] simulated InventoryHistory fetch failure");
  }
  if (id === "e2e-inv-6") return [];
  if (id === "e2e-inv-9") {
    throw new Error("[e2e-fixture] simulated InventoryHistory permanent failure (does not recover)");
  }
  if (id === "e2e-inv-7") {
    // 本物のGSI Query往復を模した非同期遅延——Nodeはシングルスレッドの
    // イベントループなので、ここを同期busy-waitにすると同じプロセスが
    // 処理する他のリクエスト(本体側の描画等)まで巻き込んで止めてしまう。
    // setTimeout+Promiseで待つことで、この1回のawaitだけが遅れ、他の
    // リクエスト/このリクエスト内の本体側の描画は影響を受けない。
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return [{ id: "h1", changedAt: now, changedBy: "e2e-fixture", fieldName: "statusId", oldValue: "st-photo", newValue: "st-listing" }];
  }
  if (id === "e2e-inv-8") {
    const failuresSoFar = historyFailOnceCounts.get(id) ?? 0;
    if (failuresSoFar === 0) {
      historyFailOnceCounts.set(id, failuresSoFar + 1);
      throw new Error("[e2e-fixture] simulated InventoryHistory transient failure (recovers on retry)");
    }
    return [{ id: "h1", changedAt: now, changedBy: "e2e-fixture", fieldName: "statusId", oldValue: "st-photo", newValue: "st-listing" }];
  }
  const row = E2E_INVENTORY_ROWS.find((r) => r.id === id) ?? E2E_INVENTORY_ROWS[0];
  if (!row) return [];
  return [{ id: "h1", changedAt: now, changedBy: "e2e-fixture", fieldName: "statusId", oldValue: "st-photo", newValue: "st-listing" }];
}
