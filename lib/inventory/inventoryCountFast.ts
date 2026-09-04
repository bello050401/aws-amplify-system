import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { directTableName } from "@/lib/amplify/directData";
import type { InventoryCursorListFilters } from "./inventoryCursorList";

/**
 * 在庫の総件数を DynamoDB の `Select: COUNT` で数える
 * (2026-09-04 性能総点検)。
 *
 * ── なぜ専用の経路を作るのか(実測) ──────────────────────────────
 *
 * 一覧の総件数は、これまで GSI を全ページ辿って**行そのものを読み**、
 * その件数を数えていた。`selectionSet: ["id"]` を付けてはいるが、
 * それは AppSync が返す項目を絞るだけで、**DynamoDB は行の中身を全部
 * 読んでいる**(射影は読んだ後に効く)。
 *
 * Staging 実測(在庫5,329件、同じ条件):
 *
 *   行を読んで数える(GSI)        16.3秒 / 11.83MB を転送
 *   Select: COUNT(GSI・直列)      3.7秒 /  0MB を転送
 *   Select: COUNT(Scan・並列8)  0.35〜0.72秒 / 0MB を転送   ← 現在
 *
 * 件数しか要らないのに12MBを運んでいた。COUNT なら DynamoDB が数えて
 * 数値だけを返すので、転送もJSONの組み立ても消える。
 * (往復数は COUNT のほうが多い —— COUNT は「走査した1MBごと」に返る
 *  ため。それでも上のとおり速い。)
 *
 * ── 2026-09-04 第2フェーズ: GSIのQueryから並列Scanへ ─────────────
 *
 * COUNT は往復回数を減らせない(1MBごとに返る)ので、残る手は「直列に
 * 待つ段数を減らす」ことだけ。Scan は TotalSegments で分割できるが、
 * GSIへのQueryはできない。数える対象は同じ —— GSIのキー条件
 * (listingPartition="ACTIVE")は、非削除行すべてに listingPartition が
 * 入っている前提(バックフィル済み、実測5,329/5,329)で
 * `attribute_not_exists(deletedAt)` と同じ集合を指す。むしろ
 * listingPartition を持たない行が将来できても Scan なら数え落とさない。
 * 新旧が同数になることは scripts/verify-inventory-count.ts が実データで
 * 突き合わせる(比較相手は従来どおりGSIを辿って行を数えた結果)。
 *
 * ── なぜ AppSync を通さないのか ──────────────────────────────────
 *
 * `Select: COUNT` は DynamoDB の機能で、Amplify Data のクライアントから
 * 指定する方法が無い。件数のためだけにこの経路を用意する。
 *
 * **認可は緩めない。** 呼び出し側(app/actions/inventoryCount.ts)が
 * `getInventoryRole()` で権限を確かめてからでないと呼ばない。ここは
 * 件数を数えるだけで、行の内容を1件も返さない —— 万一この関数が
 * 別の場所から呼ばれても、漏れるのは「条件に合う件数」だけになる。
 *
 * ── 使えないときは黙って0にしない ────────────────────────────────
 *
 * テーブル名を組み立てられない環境(CONVERSATION_TABLE_NAME 未設定)では
 * null を返す。呼び出し側が従来の経路へ落とす。0件と取り違えない。
 */

const REGION = process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-west-2";
/**
 * COUNT を割る並列セグメント数。lib/inventory/inventorySearchFast.ts と同じ理由。
 * 実測(5,329件): GSIへの直列COUNT 3,727ms → 並列8のScan COUNT 345〜715ms。
 * 数える対象・結果は同じで、直列に待つ段数だけが減る。
 */
const COUNT_SEGMENTS = 8;
/** listInventoryOffsetPage / countActiveInventory と同じ安全弁。 */
const MAX_PAGES = 60;

let cached: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cached) cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cached;
}

export interface CountExpression {
  filterExpression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
}

/**
 * lib/inventory/inventoryPage.ts の buildFilter と**同じ条件**を
 * DynamoDB の式で組み立てる。
 *
 * 2つの表現がずれると件数だけが静かに間違う。ずれていないことは
 * scripts/verify-inventory-count.ts が実データで突き合わせる。
 */
export function buildCountExpression(filters: InventoryCursorListFilters): CountExpression {
  const parts: string[] = ["attribute_not_exists(deletedAt)"];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const categoryIds = filters.categoryIds ?? [];
  if (categoryIds.length > 0) {
    // 複数選択は OR(buildFilter と同じ)。
    const ors = categoryIds.map((id, i) => {
      names["#cat"] = "categoryId";
      values[`:cat${i}`] = id;
      return `#cat = :cat${i}`;
    });
    parts.push(`(${ors.join(" OR ")})`);
  }
  if (filters.locationId) {
    names["#loc"] = "locationId";
    values[":loc"] = filters.locationId;
    parts.push("#loc = :loc");
  }
  if (filters.statusId) {
    names["#st"] = "statusId";
    values[":st"] = filters.statusId;
    parts.push("#st = :st");
  }
  return { filterExpression: parts.join(" AND "), names, values };
}

/**
 * 件数を数える。数えられなければ null(呼び出し側が従来経路へ落とす)。
 */
export async function countActiveInventoryFast(filters: InventoryCursorListFilters): Promise<number | null> {
  if (!process.env.CONVERSATION_TABLE_NAME) return null;

  let table: string;
  try {
    table = directTableName("Inventory");
  } catch {
    return null;
  }

  const { filterExpression, names, values } = buildCountExpression(filters);

  // 1セグメントぶんを最後まで数える。数え切れなければ null。
  async function countSegment(segment: number): Promise<number | null> {
    let total = 0;
    let key: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const res = await ddb().send(
        new ScanCommand({
          TableName: table,
          Segment: segment,
          TotalSegments: COUNT_SEGMENTS,
          // ここが本題。行を返さず、DynamoDB側で数えた件数だけを受け取る。
          Select: "COUNT",
          FilterExpression: filterExpression,
          ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
          ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
          ExclusiveStartKey: key,
        }),
      );
      total += res.Count ?? 0;
      key = res.LastEvaluatedKey;
      pages++;
    } while (key && pages < MAX_PAGES);
    // 打ち切った場合は「数え切れなかった」ので、途中までの数を総数として
    // 返さない —— 実際より少ない件数を平然と出すほうが有害。
    return key ? null : total;
  }

  const parts = await Promise.all(Array.from({ length: COUNT_SEGMENTS }, (_, i) => countSegment(i)));
  if (parts.some((p) => p === null)) return null;
  return parts.reduce((sum: number, p) => sum + (p ?? 0), 0);
}
