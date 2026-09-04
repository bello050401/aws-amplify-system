import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { directTableName } from "@/lib/amplify/directData";
import { buildCountExpression } from "./inventoryCountFast";
import { buildScanProjection } from "./searchScanProjection";
import { resolveDisplayInventoryId } from "./inventoryId";
import {
  evaluateQuery,
  matchesQuickSearch,
  type AdvancedSearchQuery,
  type SearchFieldDef,
  type SearchableRecord,
} from "./advancedSearch";
import type { InventoryCursorListFilters } from "./inventoryCursorList";
import { recordQuery } from "@/lib/perf/queryTiming";

/**
 * 検索を「巨大な在庫本体の全件転送」から切り離す
 * (2026-09-04 性能改善 第2フェーズ §1)。
 *
 * ── 何が問題だったか(実測) ──────────────────────────────────────
 *
 * クイック検索・詳細検索は queries.ts の fetchAllInventoryRecords を通り、
 * 非削除の在庫を**全件・全列**読んでからアプリ側で絞り込んでいた。
 * Staging(5,329件)で 16.4秒 / 14往復 / 11.83MB。50件表示するために毎回。
 *
 * ── どう変えたか ────────────────────────────────────────────────
 *
 * 検索を2段に分ける。
 *
 *   第1段(候補の絞り込み): DynamoDB へ直結し、**その検索が実際に参照する
 *     列だけ**を ProjectionExpression で読む。さらに Scan を並列セグメント
 *     に割る。判定そのものは従来と同一の関数(matchesQuickSearch /
 *     evaluateQuery)へそのまま渡す —— 検索仕様は1文字も変えない。
 *
 *   第2段(表示する行の実体化): 絞り込み後に**表示する50件だけ**を
 *     GetItem で全列取得する(同時に投げるので待ちは1往復ぶん)。
 *
 * Staging 実測(同一条件・同一データ・5,329件):
 *
 *   従来(全列・直列)            17,789ms / 14往復 / 11.83MB
 *   射影のみ(直列)               2,798ms / 14往復 /  1.95MB
 *   射影 + 並列8                 1,540ms / 直列2段 /  1.95MB
 *
 * ── 検索仕様は変えていない ──────────────────────────────────────
 *
 * 対象フィールド・部分一致・case-insensitive・AND/OR・並び順・ページング・
 * 総件数、いずれも従来と同じ関数・同じ規則で決まる。ここが変えているのは
 * 「判定に使う行を、どれだけの列を運んで組み立てるか」だけ。
 * 新旧の結果が実データで完全一致することは
 * scripts/verify-inventory-search-fast.ts が毎回照合する。
 *
 * ── 使えないときは黙って0件にしない ──────────────────────────────
 *
 * テーブル名を組み立てられない/走査が安全弁に当たった場合は null を返し、
 * 呼び出し側(queries.ts)が従来経路へ落とす。0件と取り違えない。
 *
 * ── 認可 ────────────────────────────────────────────────────────
 *
 * inventoryCountFast.ts と同じ扱い。呼び出し元は在庫一覧ページで、
 * ページ側がすでに認証・権限を確かめている。AppSync を通さないのは
 * ProjectionExpression と並列Scan(TotalSegments)が Amplify Data の
 * クライアントからは指定できないため。
 */

const REGION = process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-west-2";
/**
 * Scan を割る並列セグメント数。
 *
 * 1ページ1MBの上限は射影より前に効くので、往復の**回数**は射影では減らない。
 * 減らせるのは「直列に何段待つか」で、そこはセグメントを割れば下がる。
 * 実測(5,329件): 直列14段 5.0秒 → 4分割で4段1.9秒 → 8分割で2段1.5秒。
 * 12分割にしても1.4秒で頭打ちになり、往復総数だけが増えるので8にする。
 */
const SCAN_SEGMENTS = 8;
/** queries.ts の SEARCH_MAX_SCAN_ITEMS と同じ安全弁。超えたら従来経路へ返す。 */
const MAX_SCAN_ITEMS = 20000;
/** 実体化を同時に投げる本数。一覧の1ページ(50件)は1回で収まる。 */
const HYDRATE_CONCURRENCY = 100;

let cachedClient: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cachedClient) cachedClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cachedClient;
}

type RawItem = Record<string, unknown>;

/** queries.ts の parseCustomFields と同じ扱い(AWSJSON文字列 / 既にオブジェクト / 壊れた値)。 */
function parseCustomFieldsValue(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 判定にかけられる形へ整える。列を絞っている以外は従来の行と同じ意味になるようにする。 */
function toCandidate(raw: RawItem): SearchableRecord & { id: string; updatedAt: string } {
  return {
    ...raw,
    // 表示用の在庫IDは保存列ではなく導出値。従来経路(toListRow)と同じ関数を使う。
    displayId: resolveDisplayInventoryId({
      sourceSystem: (raw.sourceSystem as string | null | undefined) ?? null,
      sourceInventoryId: (raw.sourceInventoryId as string | null | undefined) ?? null,
      sku: raw.sku as string,
    }),
    // toListRow は数量だけ `?? 0` で埋める。ここで揃えないと
    // 「数量が空」「数量=0」の判定が新旧でずれる。
    quantity: (raw.quantity as number | null | undefined) ?? 0,
    customFields: parseCustomFieldsValue(raw.customFields),
    id: raw.id as string,
    updatedAt: raw.updatedAt as string,
  };
}

/** 従来と同じ並び(updatedAt DESC、同点はidで安定化)。 */
function compareByUpdatedAtDesc(a: { id: string; updatedAt: string }, b: { id: string; updatedAt: string }): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/** 1セグメントぶんを最後まで辿る。 */
async function scanSegment(
  table: string,
  segment: number,
  projection: ReturnType<typeof buildScanProjection>,
  filterExpression: string,
  filterNames: Record<string, string>,
  filterValues: Record<string, unknown>,
): Promise<RawItem[]> {
  const items: RawItem[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const startedAt = Date.now();
    const res = await ddb().send(
      new ScanCommand({
        TableName: table,
        Segment: segment,
        TotalSegments: SCAN_SEGMENTS,
        ProjectionExpression: projection.projectionExpression,
        FilterExpression: filterExpression,
        ExpressionAttributeNames: { ...projection.names, ...filterNames },
        ...(Object.keys(filterValues).length > 0 ? { ExpressionAttributeValues: filterValues } : {}),
        ExclusiveStartKey: key,
      }),
    );
    // 計測ハーネス(BELLO_QUERY_TIMING=1のときだけ集計される)。
    recordQuery({ model: "Inventory", op: `search-scan[seg${segment}]`, ms: Date.now() - startedAt, items: res.Items?.length ?? 0 });
    items.push(...((res.Items ?? []) as RawItem[]));
    key = res.LastEvaluatedKey;
    if (items.length >= MAX_SCAN_ITEMS) break;
  } while (key);
  return items;
}

/**
 * 表示する行だけを全列で取り直す。
 *
 * ── なぜ BatchGetItem ではなく GetItem を並べるのか ──────────────
 *
 * SSR の実行ロール(BelloAmplifyStagingComputeRole)に許可されている
 * DynamoDB の操作は GetItem / Query / Scan の3つで、BatchGetItem は
 * 入っていない。BatchGetItem を使うとここが AccessDenied で落ち、
 * 検索が毎回**従来の全件経路へフォールバックする**(= 速くならない)。
 *
 * 1ページぶん(50件)の GetItem を同時に投げれば、待ち時間は1往復ぶん
 * で済み、読み取り容量(RCU)も BatchGetItem と同じ。権限追加という
 * AWS管理者作業も要らない。
 */
async function hydrate(table: string, ids: string[]): Promise<Map<string, RawItem>> {
  const byId = new Map<string, RawItem>();
  for (let i = 0; i < ids.length; i += HYDRATE_CONCURRENCY) {
    const chunk = ids.slice(i, i + HYDRATE_CONCURRENCY);
    const startedAt = Date.now();
    const results = await Promise.all(
      chunk.map((id) => ddb().send(new GetCommand({ TableName: table, Key: { id } }))),
    );
    recordQuery({
      model: "Inventory",
      op: `search-hydrate[x${chunk.length}]`,
      ms: Date.now() - startedAt,
      items: results.filter((r) => r.Item).length,
    });
    for (const res of results) {
      if (res.Item) byId.set(res.Item.id as string, res.Item as RawItem);
    }
  }
  return byId;
}

export interface FastSearchInput {
  /** サイドバーの絞り込み。DynamoDB の FilterExpression として押し下げる。 */
  filters?: InventoryCursorListFilters;
  /** クイック検索の文字列(在庫ID/SKU/物品名の部分一致)。 */
  q?: string;
  /** 詳細検索。 */
  advanced?: { query: AdvancedSearchQuery; fieldsByKey: Map<string, SearchFieldDef> };
}

export interface FastSearchPage {
  /** 表示する行の生データ(呼び出し側が従来の toSearchRecord に通す)。 */
  rawItems: RawItem[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * 検索を実行する。使えない環境・安全弁に当たった場合は null
 * (呼び出し側が従来経路へ落とす)。
 */
export async function searchInventoryFast(
  input: FastSearchInput,
  options: { offset: number; limit: number },
): Promise<FastSearchPage | null> {
  if (!process.env.CONVERSATION_TABLE_NAME) return null;
  let table: string;
  try {
    table = directTableName("Inventory");
  } catch {
    return null;
  }

  // 走査の対象は「非削除 + サイドバーの絞り込み」。件数集計と同じ式を
  // 使い回す —— 条件を2通りに書くと結果だけが静かにずれる。
  const { filterExpression, names: filterNames, values: filterValues } = buildCountExpression(input.filters ?? {});

  // その検索が実際に参照する列だけを射影に入れる。
  const referencedKeys: string[] = ["displayId"];
  if (input.advanced) {
    for (const condition of input.advanced.query.conditions) {
      if (condition.field) referencedKeys.push(condition.field);
    }
  }
  const projection = buildScanProjection(referencedKeys);

  const segments = await Promise.all(
    Array.from({ length: SCAN_SEGMENTS }, (_, i) =>
      scanSegment(table, i, projection, filterExpression, filterNames, filterValues),
    ),
  );
  const raw = segments.flat();
  // 安全弁に当たった = 全件を見られていない。件数も結果も信用できないので
  // 従来経路へ返す(途中までの結果を総件数として出さない)。
  if (raw.length >= MAX_SCAN_ITEMS) return null;

  const candidates = raw.map(toCandidate);
  const q = input.q?.trim();
  const filtered = candidates.filter((record) => {
    if (input.advanced && !evaluateQuery(record, input.advanced.query, input.advanced.fieldsByKey)) return false;
    if (q && !matchesQuickSearch(record, q)) return false;
    return true;
  });
  filtered.sort(compareByUpdatedAtDesc);

  const page = filtered.slice(options.offset, options.offset + options.limit);
  const byId = await hydrate(
    table,
    page.map((r) => r.id),
  );
  // 走査した直後に別セッションが削除した行は BatchGet で返らない。
  // 埋め合わせに別の行を繰り上げると総件数と食い違うので、落ちた行は
  // そのまま落とす(従来経路でも同じことが起きうる)。
  const rawItems = page.map((r) => byId.get(r.id)).filter((x): x is RawItem => Boolean(x));

  return { rawItems, total: filtered.length, offset: options.offset, limit: options.limit };
}
