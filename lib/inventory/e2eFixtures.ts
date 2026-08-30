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

import type { InventoryListRow, InventoryDetail, MasterOption, StatusOption, SearchPage, CustomFieldDefinitionRow } from "./queries";

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
    mainImageStorageKey: null,
    mainImageThumbnailKey: null,
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

export function e2eInventoryDetail(id: string): InventoryDetail | null {
  const row = E2E_INVENTORY_ROWS.find((r) => r.id === id) ?? E2E_INVENTORY_ROWS[0];
  if (!row) return null;
  return {
    ...row,
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
    images: [],
    createdBy: "e2e-fixture",
    updatedBy: "e2e-fixture",
    history: [
      { id: "h1", changedAt: now, changedBy: "e2e-fixture", fieldName: "statusId", oldValue: "st-photo", newValue: "st-listing" },
    ],
  };
}
