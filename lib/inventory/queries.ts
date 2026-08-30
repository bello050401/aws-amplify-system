import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { Schema } from "@/amplify/data/resource";
import { parseCustomFields } from "./customFieldsCodec";
import type { InventoryExtendedFields } from "./extendedFields";
import { effectiveListThumbnailKey, normalizeImageRecord, resolveTopImage, type InventoryImageRecord } from "./imageTypes";
import { resolveDisplayInventoryId } from "./inventoryId";
import { evaluateQuery, matchesQuickSearch, type AdvancedSearchQuery, type SearchFieldDef, type SearchableRecord } from "./advancedSearch";
import {
  isE2EFixtureModeActive,
  E2E_CATEGORIES,
  E2E_LOCATIONS,
  E2E_STATUSES,
  E2E_CUSTOM_FIELD_DEFS,
  e2eListPage,
  e2eInventoryDetail,
} from "./e2eFixtures";

type InventoryModel = Schema["Inventory"]["type"];

export interface InventoryListFilters {
  q?: string; // matches name OR sku, partial
  /** OR across every selected category (spec: 複数選択時はOR条件) — an empty/absent array means no category filter at all, not "match nothing". */
  categoryIds?: string[];
  locationId?: string;
  statusId?: string;
}

export interface InventoryListRow {
  id: string;
  sku: string;
  /** ユーザーに見せる「在庫ID」— sku('B000001'等)とは別概念。ZAICO由来の商品はZAICOの在庫IDをそのまま表示し、BELLO作成の商品はskuを表示する。See lib/inventory/inventoryId.ts。 */
  displayId: string;
  sourceSystem: string | null;
  sourceInventoryId: string | null;
  name: string;
  categoryId: string | null;
  statusId: string | null;
  locationId: string | null;
  quantity: number;
  unit: string | null;
  purchasePrice: number | null;
  salePrice: number | null;
  // Phase C — kept on the list row (unlike the rest of extendedFields,
  // which is detail-only) since it's a default-visible list column; see
  // lib/inventory/listColumns.ts.
  plannedSalePrice: number | null;
  note: string | null;
  mainImageStorageKey: string | null;
  /** BELLO統合改修 master指示書 Phase B: the key the list view should actually fetch — the top image's small thumbnail when one exists, `mainImageStorageKey` (the original) otherwise. Only ever used by the list table's InventoryThumbnail; every other screen keeps using `mainImageStorageKey`/`storageKey` directly. */
  mainImageThumbnailKey: string | null;
  createdAt: string;
  updatedAt: string;
  // Additional optional list columns (統合改善指示書 §10) — the same
  // extendedFields already readable on the detail/edit screens, now also
  // available as opt-in list columns. See lib/inventory/listColumns.ts
  // for which ones actually show by default.
  barcode: string | null;
  saleCommission: number | null;
  market: string | null;
  saleStartDate: string | null;
  saleEndDate: string | null;
  width: string | null;
  depth: string | null;
  height: string | null;
  conditionRating: string | null;
  damageNotes: string | null;
  transactionDate: string | null;
  transactionType: string | null;
  adminMemo: string | null;
  /** 追加項目(CustomFieldDefinition)の値 — 一覧の動的列(夜間開発指示書 §11、lib/inventory/listColumns.tsのdynamicColumnDefsFrom)がkeyで直接読む。 */
  customFields: Record<string, unknown> | null;
}

/** Every image on the record, normalized (legacy rows with no `type` read as NORMAL — see lib/inventory/imageTypes.ts). Shared by toListRow (just needs the resolved top image) and getInventoryDetail (needs the full normal/damage breakdown). */
function normalizedImages(item: InventoryModel): InventoryImageRecord[] {
  return (item.images ?? []).filter((img): img is NonNullable<typeof img> => Boolean(img)).map(normalizeImageRecord);
}

/**
 * 第六ラウンドP0-5: lib/inventory/inventoryCursorList.ts(新設、真の
 * サーバー側cursor pagination)からも同じInventoryModel→InventoryListRow
 * 変換を再利用するためexportする — 一覧の行データ構造を2箇所で別々に
 * 組み立てて将来ズレるのを防ぐ。
 */
export function toListRow(item: InventoryModel): InventoryListRow {
  const images = normalizedImages(item);
  return {
    id: item.id,
    sku: item.sku,
    displayId: resolveDisplayInventoryId({ sourceSystem: item.sourceSystem ?? null, sourceInventoryId: item.sourceInventoryId ?? null, sku: item.sku }),
    sourceSystem: item.sourceSystem ?? null,
    sourceInventoryId: item.sourceInventoryId ?? null,
    name: item.name,
    categoryId: item.categoryId ?? null,
    statusId: item.statusId ?? null,
    locationId: item.locationId ?? null,
    quantity: item.quantity ?? 0,
    unit: item.unit ?? null,
    purchasePrice: item.purchasePrice ?? null,
    salePrice: item.salePrice ?? null,
    plannedSalePrice: item.plannedSalePrice ?? null,
    note: item.note ?? null,
    // Phase C.5: the explicit top image (isPrimary, falling back to the
    // first NORMAL image) rather than simply `images[0]` — a damage
    // photo can never end up as the list thumbnail even if it happens to
    // sort first. See resolveTopImage's own comment.
    mainImageStorageKey: resolveTopImage(images)?.storageKey ?? null,
    mainImageThumbnailKey: (() => {
      const top = resolveTopImage(images);
      return top ? effectiveListThumbnailKey(top) : null;
    })(),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    barcode: item.barcode ?? null,
    saleCommission: item.saleCommission ?? null,
    market: item.market ?? null,
    saleStartDate: item.saleStartDate ?? null,
    saleEndDate: item.saleEndDate ?? null,
    width: item.width ?? null,
    depth: item.depth ?? null,
    height: item.height ?? null,
    conditionRating: item.conditionRating ?? null,
    damageNotes: item.damageNotes ?? null,
    transactionDate: item.transactionDate ?? null,
    transactionType: item.transactionType ?? null,
    adminMemo: item.adminMemo ?? null,
    customFields: parseCustomFields(item.customFields),
  };
}

/** Every Phase C field mapped to `T | null` (instead of extendedFields.ts's `T | undefined`, used for form-state parsing) — this is what a fully-read Inventory record actually looks like: every field always present on the object, absent ones simply null. Derived from InventoryExtendedFields with `type` rather than re-listed, so the two can't drift apart. */
type ExtendedFieldsAsNullable = { [K in keyof InventoryExtendedFields]-?: NonNullable<InventoryExtendedFields[K]> | null };

function toExtendedFields(item: InventoryModel): ExtendedFieldsAsNullable {
  return {
    barcode: item.barcode ?? null,
    plannedSalePrice: item.plannedSalePrice ?? null,
    firstMarkdownPrice: item.firstMarkdownPrice ?? null,
    secondMarkdownPrice: item.secondMarkdownPrice ?? null,
    thirdMarkdownPrice: item.thirdMarkdownPrice ?? null,
    saleStartDate: item.saleStartDate ?? null,
    saleEndDate: item.saleEndDate ?? null,
    market: item.market ?? null,
    externalProductId: item.externalProductId ?? null,
    saleCommission: item.saleCommission ?? null,
    listingNotes: item.listingNotes ?? null,
    conditionRating: item.conditionRating ?? null,
    damageNotes: item.damageNotes ?? null,
    width: item.width ?? null,
    depth: item.depth ?? null,
    height: item.height ?? null,
    overallLength: item.overallLength ?? null,
    lengthAdjustable: item.lengthAdjustable ?? null,
    mountType: item.mountType ?? null,
    usedGoodsItemType: item.usedGoodsItemType ?? null,
    transactionDate: item.transactionDate ?? null,
    purchaseQuantity: item.purchaseQuantity ?? null,
    transactionType: item.transactionType ?? null,
    identityVerificationMethod: item.identityVerificationMethod ?? null,
    counterpartyName: item.counterpartyName ?? null,
    counterpartyOccupation: item.counterpartyOccupation ?? null,
    counterpartyAddress: item.counterpartyAddress ?? null,
    shippingCost: item.shippingCost ?? null,
    dailyPurchaseTotal: item.dailyPurchaseTotal ?? null,
    adminMemo: item.adminMemo ?? null,
  };
}

/**
 * Cursor-paginated list (AppSync `nextToken`), NOT "fetch everything and
 * paginate client-side" — spec §27 explicitly rules that out so this
 * still holds up once inventory count grows well past what fits in one
 * response. `includeDeleted` powers the separate 削除済み在庫 screen
 * (not built in Phase 3, but the query already supports it so that
 * screen is additive later, not a rework of this one).
 */
/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §8/§9根本修正 —
 * 以前はここだけ独立したAppSync cursor(nextToken)ページングだった
 * (DynamoDBレベルでfilterのみ絞り込み、limit件だけ返す)。これには
 * 2つの実害があった:
 *   1. ソート順が一切保証されない(DynamoDBの物理scan順のまま) —
 *      「updatedAt DESC」を満たせなかった(§9)。
 *   2. 「総件数」を返せない(1ページ分のitems.lengthしか分からない) —
 *      一覧上部の「〜件」がページ内件数を超えて表示できなかった(§8)。
 * さらにnextTokenを積み上げて「前へ」を再現するUI側の実装が、
 * HTTP 431の実障害を引き起こしてもいた(InventoryPagination.tsx参照)。
 *
 * 修正: クイック検索/詳細検索と全く同じ設計(fetchAllInventoryRecords
 * による、DynamoDBレベルの絞り込み+deletedAt除外を適用した全件取得→
 * updatedAt DESCで一括ソート→offsetでページ分割)へ統一した。この規模
 * (SEARCH_MAX_SCAN_ITEMS=20000件が安全弁、現状の運用規模である
 * 「1000件超」を大きく上回る)では、「一覧に必要な列だけを持つ軽量な
 * レコード(画像本体やhistoryは含まない)を1回だけ全件取得してメモリ上
 * でソート・ページ分割する」ことは、DynamoDBに複合GSIを追加してソート
 * 済みクエリを都度投げるより実装・運用コストが低く、既存のクイック
 * 検索/詳細検索と同じ「全件走査」設計にそろえることで一覧全体のソート
 * ・カウント方式を1箇所(fetchAllInventoryRecords)に統一できる利点が
 * 上回ると判断した。将来この規模を大きく超える場合はOpenSearch等への
 * 切り替えが必要になる旨をfetchAllInventoryRecords/SEARCH_MAX_SCAN_ITEMS
 * のコメントに明記済み。
 */
export async function listInventory(filters: InventoryListFilters, options: { offset: number; limit: number }): Promise<SearchPage<InventoryListRow>> {
  // 第五ラウンド§7/P1-A: e2eFixtures.tsの安全ゲート参照(NODE_ENV!==
  // "production" AND 明示的opt-in環境変数——実デプロイでは構造的に
  // 絶対に成立しない)。Playwright E2Eが実際の保護されたルート
  // (このファイルの各関数を実際に呼ぶ本物のpage.tsx/layout.tsx)を
  // 本物のブラウザで描画するために、DB読み取りだけをこのfixtureへ
  // 差し替える——書き込み系には一切適用しない。
  if (isE2EFixtureModeActive()) return e2eListPage(options.offset, options.limit);
  const conditions: Record<string, unknown>[] = [];
  // 複数カテゴリはOR条件（いずれかに一致）、他の条件とはAND — spec §9。
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    conditions.push({ or: filters.categoryIds.map((id) => ({ categoryId: { eq: id } })) });
  }
  if (filters.locationId) conditions.push({ locationId: { eq: filters.locationId } });
  if (filters.statusId) conditions.push({ statusId: { eq: filters.statusId } });

  const all = await fetchAllInventoryRecords(conditions);
  const total = all.length;
  const page = all.slice(options.offset, options.offset + options.limit);
  return { items: page, total, offset: options.offset, limit: options.limit };
}

// ────────────────────────────────────────────────────────────────────
// 通常一覧・クイック検索・詳細検索・売上集計に共通の全件取得
// (夜間開発指示書 §6/§7/§12)。
//
// ※このコメントは以前「listInventoryはcursorページングの安価な経路と
//   して無変更で残す」と書いていたが、実態と食い違っていた — 上の
//   listInventoryも既にこの関数を経由する(§9のupdatedAt DESC統一で
//   そう変更された)。**通常の一覧表示も毎回全件を取得してから
//   メモリ上でソート・スライスする**。1,000件時点でStagingのTTFBは
//   実測3.2秒で、件数に比例して伸びる。SEARCH_MAX_SCAN_ITEMS(20,000)を
//   安全弁としているが、実用上はその手前で体感が悪化するため、規模が
//   増えたらcursor方式(lib/inventory/inventoryCursorList.ts)への移行か
//   OpenSearch等が必要になる。
//
// 一覧はトップ画像のサムネイルを出すためimages配列を必要とするので、
// 「軽い列だけ取る」形へは単純には落とせない(selectionSetで削ると
//  サムネイルが出なくなる)。DynamoDBの`contains`はcase-sensitiveであり、
// 保存値をlowercase化することも禁止されているため、文字列演算子の判定
// はこの走査で取得した候補集合に対しapplication code側でcase-insensitive
// に行う(lib/inventory/advancedSearch.ts参照) — フロントだけ
// lowercaseにする見かけだけの実装ではない。
// ────────────────────────────────────────────────────────────────────

export interface InventorySearchRecord extends InventoryListRow, ExtendedFieldsAsNullable {
  customFields: Record<string, unknown> | null;
}

function toSearchRecord(item: InventoryModel): InventorySearchRecord {
  return { ...toListRow(item), ...toExtendedFields(item), customFields: parseCustomFields(item.customFields) };
}

/** 想定規模を大きく超える件数の走査を続けて詰まらせないための安全弁(lib/inventory/inventoryImport.tsのIMPORT_MAX_ROWSと同じ考え方)。将来的にもっと大きな規模が必要になった場合はOpenSearch等の全文検索基盤への切り替えが必要になる旨を完了報告に明記する。 */
export const SEARCH_MAX_SCAN_ITEMS = 20000;

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §9: 一覧デフォルト
 * はupdatedAt DESC(直近で実際に変更された商品が最上位)。純粋な比較
 * 関数として切り出してあるのは、scripts/verify-zaico-sync.tsから
 * serverDataClient/AWSに一切触れずに直接テストできるようにするため。
 * 同点(同一updatedAt、通常は起きないが理論上)はidで安定ソートする —
 * 「毎回結果の順序が変わる」ことを避ける。
 *
 * 既知の残課題(2026-08-29統合改修版 taskラウンド、意図的に未修正 —
 * 理由はlib/inventory/thumbnailBackfill.tsの該当コメント参照): この
 * `updatedAt`はInventoryモデルに明示フィールドを持たない、Amplifyの
 * 自動管理タイムスタンプであり、成功した`.update()`呼び出しなら中身が
 * ユーザーにとって意味のある変更かどうかに関わらず必ず「今」へ更新さ
 * れる。ZAICO同期・編集画面保存・一括編集・インラインー編集・重複統合
 * (masterDedupe)・インポートの各書き込みはすべて実際のユーザー向け
 * フィールド変更なので、この一覧の意図(「直近で実際に変更された商品
 * が最上位」)と一致する。唯一の例外がlib/inventory/thumbnailBackfill.ts
 * ―既存画像へのサムネイル遡及生成で、ユーザーには見えないthumbnailKey
 * だけを書き込むためこの一覧の意図とは食い違う。
 */
export function compareByUpdatedAtDesc(a: { id: string; updatedAt: string }, b: { id: string; updatedAt: string }): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/**
 * 追加のAppSync filter条件(サイドバーのカテゴリ/保管場所/状態等、
 * DynamoDBレベルで絞り込めるもの)を先に適用したうえで、非削除の全件
 * をページングしながら取得する。
 */
async function fetchAllInventoryRecords(extraConditions: Record<string, unknown>[] = []): Promise<InventorySearchRecord[]> {
  const items: InventorySearchRecord[] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.Inventory.list({
      filter: { and: [{ deletedAt: { attributeExists: false } }, ...extraConditions] },
      limit: 200,
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    if (errors) throw new Error(`在庫データの取得に失敗しました: ${JSON.stringify(errors)}`);
    items.push(...data.map(toSearchRecord));
    nextToken = nt;
    if (items.length >= SEARCH_MAX_SCAN_ITEMS) break;
  } while (nextToken);
  // BELLO統合改修 master指示書(2026-08-29統合改修版) §9根本修正:
  // 一覧デフォルトはupdatedAt DESC(直近で実際に変更された商品が最上位)
  // — 以前はInventory.list()自体がDynamoDBの物理scan順(意味のある
  // 順序を一切保証しない)をそのまま返しており、明示的なsortが一つも
  // 無かった。ここで一度だけ、全経路(通常一覧/クイック検索/詳細検索
  // すべてがこの関数を経由する)が共有するソートとして適用する —
  // 呼び出し側でバラバラに実装しない。同点(同一updatedAt、通常は起き
  // ないが理論上)はidで安定ソートする。
  items.sort(compareByUpdatedAtDesc);
  return items;
}

/** 売上集計(統合改善指示書)等、フィルタなしで在庫全件が必要な呼び出し向け。 */
export async function listAllInventory(): Promise<InventorySearchRecord[]> {
  return fetchAllInventoryRecords();
}

export interface SearchPage<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * クイック検索(商品検索ボックスの`q`)専用 — 在庫ID/SKU/物品名への
 * case-insensitive部分一致。カテゴリ/保管場所/状態はDynamoDBへ実際に
 * 絞り込み条件として渡す(既存listInventoryと同じ条件組み立て)。
 * `q`が空文字列の場合でもこの経路を通すのは、カテゴリ複数選択済み+
 * 直近まで検索語があったURLの整合性のため呼び出し元(page.tsx)が判断
 * する — この関数自体は空qなら絞り込みなしとして全件を返す。
 */
export async function listInventorySimpleSearch(
  filters: InventoryListFilters,
  options: { offset: number; limit: number },
): Promise<SearchPage<InventoryListRow>> {
  if (isE2EFixtureModeActive()) return e2eListPage(options.offset, options.limit); // 第五ラウンド§7/P1-A、listInventoryと同じ安全ゲート
  const conditions: Record<string, unknown>[] = [];
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    conditions.push({ or: filters.categoryIds.map((id) => ({ categoryId: { eq: id } })) });
  }
  if (filters.locationId) conditions.push({ locationId: { eq: filters.locationId } });
  if (filters.statusId) conditions.push({ statusId: { eq: filters.statusId } });

  const all = await fetchAllInventoryRecords(conditions);
  const q = filters.q?.trim();
  const filtered = q ? all.filter((r) => matchesQuickSearch(r as unknown as SearchableRecord, q)) : all;

  const total = filtered.length;
  const page = filtered.slice(options.offset, options.offset + options.limit);
  return { items: page, total, offset: options.offset, limit: options.limit };
}

/**
 * 詳細検索(spec §7)— AND/OR・演算子つきの複数条件で在庫全件から絞り
 * 込む。カテゴリ/保管場所/状態/日付/数値も含め、すべての判定を
 * lib/inventory/advancedSearch.tsのevaluateQueryへ委譲する(AND/ORが
 * 混在する条件をDynamoDB filter単体では正しく表現できないため、この
 * 経路は非削除フィルタ以外をDynamoDBへ渡さず、全件走査後にアプリケー
 * ションコード側で判定する — 既存のexport/import機能と同じ「全件を
 * 一度読んで判定する」設計を踏襲)。
 */
export async function listInventoryAdvanced(
  query: AdvancedSearchQuery,
  fieldsByKey: Map<string, SearchFieldDef>,
  options: { offset: number; limit: number },
): Promise<SearchPage<InventoryListRow>> {
  if (isE2EFixtureModeActive()) return e2eListPage(options.offset, options.limit); // 第五ラウンド§7/P1-A、listInventoryと同じ安全ゲート
  const all = await fetchAllInventoryRecords();
  const filtered = all.filter((r) => evaluateQuery(r as unknown as SearchableRecord, query, fieldsByKey));

  const total = filtered.length;
  const page = filtered.slice(options.offset, options.offset + options.limit);
  return { items: page, total, offset: options.offset, limit: options.limit };
}

export interface InventoryHistoryRow {
  id: string;
  changedAt: string;
  changedBy: string | null;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface InventoryDetail extends InventoryListRow, ExtendedFieldsAsNullable {
  images: InventoryImageRecord[]; // both NORMAL and DAMAGE, normalized — callers split via lib/inventory/imageTypes.ts's splitImagesByType
  customFields: Record<string, unknown> | null;
  createdBy: string | null;
  updatedBy: string | null;
  history: InventoryHistoryRow[];
}

export async function getInventoryDetail(id: string): Promise<InventoryDetail | null> {
  if (isE2EFixtureModeActive()) return e2eInventoryDetail(id); // 第五ラウンド§7/P1-A、listInventoryと同じ安全ゲート
  const { data: item } = await serverDataClient.models.Inventory.get({ id }, inventoryAuthMode);
  if (!item || item.deletedAt) return null;

  // 第五ラウンド§6(P0-B) GSI/Scan監査: このモデルはsecondaryIndexes
  // (inventoryId + changedAt sort key)を実際に宣言済みだが、以前は他の
  // モデルの慣例(lib/imageProcessing/jobService.tsのlistVersions等)に
  // 合わせて`.list({filter})`——DynamoDB Scan相当、テーブル全体の行数に
  // 比例したコスト——で呼んでいた。InventoryHistoryは「一度書いたら
  // 消さない追記専用の監査ログ」で件数が無制限に増え続け(モデル定義の
  // コメント参照)、かつこの呼び出しは商品詳細ページを開くたび=高頻度
  // に発生するため、他のGSI未使用箇所より優先度が高い(監査結果は
  // docs/gsi-scan-audit.md参照)。生成されたクエリField名は
  // synth出力のmodel-schema.graphqlで実測確認済み
  // (`listInventoryHistoryByInventoryIdAndChangedAt`)——真のDynamoDB
  // Query(該当inventoryIdの行だけを読む)に切り替える。
  const { data: historyRows } = await serverDataClient.models.InventoryHistory.listInventoryHistoryByInventoryIdAndChangedAt(
    { inventoryId: id },
    { ...inventoryAuthMode },
  );

  return {
    ...toListRow(item),
    ...toExtendedFields(item),
    images: normalizedImages(item),
    customFields: parseCustomFields(item.customFields),
    createdBy: item.createdBy ?? null,
    updatedBy: item.updatedBy ?? null,
    history: historyRows
      .map((h) => ({
        id: h.id,
        changedAt: h.changedAt,
        changedBy: h.changedBy ?? null,
        fieldName: h.fieldName,
        oldValue: h.oldValue ?? null,
        newValue: h.newValue ?? null,
      }))
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt)),
  };
}

export interface MasterOption {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

/**
 * Master tables are small (admin-managed lists), so a plain full list —
 * sorted client-side by sortOrder then name — is the natural fit here,
 * unlike the cursor-paginated Inventory list above.
 *
 * `includeInactiveId`: a record that has since been deactivated in
 * /inventory/settings must not vanish from a form that's currently
 * displaying it — an Inventory row that already references it still
 * needs to show/keep that value (spec: 無効化しても既存参照は壊さない).
 * Only the one id already on the record being viewed/edited is ever
 * added this way, never the full inactive set — this stays a small,
 * targeted lookup, not a second full table scan. It's suffixed
 * "（無効）" so it reads as a deactivated option, not an active choice
 * a user could newly pick some other way.
 */
export async function listCategories(includeInactiveId?: string | null): Promise<MasterOption[]> {
  if (isE2EFixtureModeActive()) return E2E_CATEGORIES; // 第五ラウンド§7/P1-A、listInventoryと同じ安全ゲート
  const { data } = await serverDataClient.models.Category.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  const options = data
    .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId ?? null, sortOrder: c.sortOrder ?? 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));

  if (includeInactiveId && !options.some((o) => o.id === includeInactiveId)) {
    const { data: inactive } = await serverDataClient.models.Category.get({ id: includeInactiveId }, inventoryAuthMode);
    if (inactive) {
      options.push({ id: inactive.id, name: `${inactive.name}（無効）`, parentId: inactive.parentId ?? null, sortOrder: inactive.sortOrder ?? 0 });
    }
  }
  return options;
}

export async function listLocations(includeInactiveId?: string | null): Promise<MasterOption[]> {
  if (isE2EFixtureModeActive()) return E2E_LOCATIONS; // 第五ラウンド§7/P1-A、listInventoryと同じ安全ゲート
  const { data } = await serverDataClient.models.Location.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  const options = data
    .map((l) => ({ id: l.id, name: l.name, parentId: l.parentId ?? null, sortOrder: l.sortOrder ?? 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));

  if (includeInactiveId && !options.some((o) => o.id === includeInactiveId)) {
    const { data: inactive } = await serverDataClient.models.Location.get({ id: includeInactiveId }, inventoryAuthMode);
    if (inactive) {
      options.push({ id: inactive.id, name: `${inactive.name}（無効）`, parentId: inactive.parentId ?? null, sortOrder: inactive.sortOrder ?? 0 });
    }
  }
  return options;
}

/**
 * 単位マスタ(夜間開発指示書 §10)の有効な名称一覧 — 新規登録/編集フォー
 * ムの「単位」入力欄のdatalist候補として使う。Category/Locationと違い
 * Inventory.unitはこのidを参照する外部キーではなく従来通りの自由文字
 * 列のままなので、ここでは`id`は返さず名称の配列だけを返す(呼び出し
 * 側がidを必要とする理由がない)。
 */
export async function listUnits(): Promise<string[]> {
  // UnitMasterはAWS側の再デプロイが済むまでバックエンドに存在しない
  // 可能性がある(lib/inventory/masters.tsのlistAllMasterEntriesの同種
  // コメント参照) — 失敗しても新規登録/編集フォーム自体は壊さず、単に
  // 候補なし(自由入力のみ)として続行する。
  try {
    const { data } = await serverDataClient.models.UnitMaster.list({
      filter: { isActive: { eq: true } },
      ...inventoryAuthMode,
    });
    return (data ?? [])
      .map((u) => ({ name: u.name, sortOrder: u.sortOrder ?? 0 }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"))
      .map((u) => u.name);
  } catch (err) {
    console.warn("[listUnits] UnitMasterの取得に失敗しました(AWS側の再デプロイが未実施の可能性があります):", err);
    return [];
  }
}

export interface StatusOption {
  id: string;
  code: string;
  label: string;
  sortOrder: number;
}

export async function listStatuses(): Promise<StatusOption[]> {
  if (isE2EFixtureModeActive()) return E2E_STATUSES; // 第五ラウンド§7/P1-A、listInventoryと同じ安全ゲート
  const { data } = await serverDataClient.models.StatusMaster.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  return data
    .map((s) => ({ id: s.id, code: s.code, label: s.label, sortOrder: s.sortOrder ?? 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export interface CustomFieldDefinitionRow {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: Schema["CustomFieldType"]["type"];
  required: boolean;
  sortOrder: number;
  options: string[];
  isActive: boolean;
}

function toCustomFieldDefinitionRow(f: {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: Schema["CustomFieldType"]["type"];
  required?: boolean | null;
  sortOrder?: number | null;
  options?: (string | null)[] | null;
  isActive?: boolean | null;
}): CustomFieldDefinitionRow {
  return {
    id: f.id,
    fieldKey: f.fieldKey,
    label: f.label,
    fieldType: f.fieldType,
    required: f.required ?? false,
    sortOrder: f.sortOrder ?? 0,
    options: (f.options ?? []).filter((o): o is string => Boolean(o)),
    isActive: f.isActive ?? true,
  };
}

/** 新規登録/編集フォーム・検索・Import/Export等、実際にユーザーへ入力・表示させる側が使う — 無効化された追加項目は含まない。 */
export async function listCustomFieldDefinitions(): Promise<CustomFieldDefinitionRow[]> {
  if (isE2EFixtureModeActive()) return E2E_CUSTOM_FIELD_DEFS; // 第五ラウンド§7/P1-A、listInventoryと同じ安全ゲート
  const { data } = await serverDataClient.models.CustomFieldDefinition.list({
    filter: { isActive: { eq: true } },
    ...inventoryAuthMode,
  });
  return data.map(toCustomFieldDefinitionRow).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** 設定画面の追加項目管理タブ専用 — 無効化済みも含めた全件(ADMINが再度有効化できるように、lib/inventory/masters.tsのlistAllMasterEntriesと同じ考え方)。 */
export async function listAllCustomFieldDefinitions(): Promise<CustomFieldDefinitionRow[]> {
  const { data } = await serverDataClient.models.CustomFieldDefinition.list(inventoryAuthMode);
  return data.map(toCustomFieldDefinitionRow).sort((a, b) => a.sortOrder - b.sortOrder);
}
