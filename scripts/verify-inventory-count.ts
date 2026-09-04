/**
 * 件数の高速集計が、従来の数え方と**同じ数**を返すことを実データで確かめる
 * (2026-09-04 性能総点検)。
 *
 *   AWS_PROFILE=Bello npm run verify:inventory-count
 *
 * ── なぜこの検証が要るのか ──────────────────────────────────────
 *
 * 件数の集計は、Amplify のフィルタ(lib/inventory/inventoryPage.ts の
 * buildFilter)と DynamoDB の式(inventoryCountFast.ts の
 * buildCountExpression)で**同じ条件を2通りに書いている**。
 * ずれても画面はエラーにならず、**件数だけが静かに違う**という形で出る。
 * 一番気づきにくい壊れ方なので、実データで突き合わせる。
 *
 * 比較の相手は「GSIを全ページ辿って行を数えた結果」——つまり従来の
 * 数え方そのもの。同じGSI・同じ条件で、読み方だけが違う。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ensureConversationTableName } from "./lib/resolveStagingTables";

let failures = 0;
let passes = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passes++;
    console.log(`✓ ${label} — ${JSON.stringify(actual)}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}\n    期待: ${JSON.stringify(expected)}\n    実際: ${JSON.stringify(actual)}`);
  }
}

const REGION = process.env.AWS_REGION || "us-west-2";
const INDEX_NAME = "inventoriesByListingPartitionAndListUpdatedAt";

/** 従来の数え方: GSIを全ページ辿って、返ってきた行を数える。 */
async function countByReadingRows(
  ddb: DynamoDBDocumentClient,
  table: string,
  filterExpression: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
): Promise<number> {
  let total = 0;
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        IndexName: INDEX_NAME,
        KeyConditionExpression: "#partition = :partition",
        ExpressionAttributeNames: { "#partition": "listingPartition", ...names },
        ExpressionAttributeValues: { ":partition": "ACTIVE", ...values },
        FilterExpression: filterExpression,
        ExclusiveStartKey: key,
      }),
    );
    total += res.Items?.length ?? 0;
    key = res.LastEvaluatedKey;
  } while (key);
  return total;
}

async function main() {
  await ensureConversationTableName();
  const { countActiveInventoryFast, buildCountExpression } = await import("@/lib/inventory/inventoryCountFast");
  const { directTableName } = await import("@/lib/amplify/directData");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const table = directTableName("Inventory");

  console.log(`[verify-inventory-count] ${table}`);

  // 実在するカテゴリー・保管場所・ステータスを拾って、実際に使われる
  // 組み合わせで確かめる(存在しないIDで0件同士が一致しても意味が無い)。
  const sample = await ddb.send(
    new QueryCommand({
      TableName: table,
      IndexName: INDEX_NAME,
      KeyConditionExpression: "#p = :p",
      ExpressionAttributeNames: { "#p": "listingPartition" },
      ExpressionAttributeValues: { ":p": "ACTIVE" },
      Limit: 200,
    }),
  );
  const rows = (sample.Items ?? []) as { categoryId?: string; locationId?: string; statusId?: string }[];
  const someCategory = rows.find((r) => r.categoryId)?.categoryId;
  const otherCategory = rows.find((r) => r.categoryId && r.categoryId !== someCategory)?.categoryId;
  const someLocation = rows.find((r) => r.locationId)?.locationId;
  const someStatus = rows.find((r) => r.statusId)?.statusId;

  const cases: { label: string; filters: Parameters<typeof countActiveInventoryFast>[0] }[] = [
    { label: "条件なし(全件)", filters: {} },
    ...(someCategory ? [{ label: "カテゴリー1件", filters: { categoryIds: [someCategory] } }] : []),
    ...(someCategory && otherCategory
      ? [{ label: "カテゴリー2件(OR)", filters: { categoryIds: [someCategory, otherCategory] } }]
      : []),
    ...(someLocation ? [{ label: "保管場所", filters: { locationId: someLocation } }] : []),
    ...(someStatus ? [{ label: "在庫ステータス", filters: { statusId: someStatus } }] : []),
    ...(someCategory && someLocation
      ? [{ label: "カテゴリー + 保管場所(AND)", filters: { categoryIds: [someCategory], locationId: someLocation } }]
      : []),
    { label: "存在しないカテゴリー(0件になるべき)", filters: { categoryIds: ["__not-a-real-id__"] } },
  ];

  for (const c of cases) {
    const expr = buildCountExpression(c.filters);
    const [fast, slow] = await Promise.all([
      countActiveInventoryFast(c.filters),
      countByReadingRows(ddb, table, expr.filterExpression, expr.names, expr.values),
    ]);
    assertEqual(fast, slow, `${c.label}: Select:COUNT と 行を数える結果が一致する`);
  }

  console.log(`\n合格 ${passes} / 失敗 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

void main().catch((err) => {
  console.error(`[verify-inventory-count] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
