/**
 * 各画面が「開くだけ」で読むデータ量を、実データに対して直接測る。
 *
 * ブラウザ計測はログインが要るため、ここではサーバー側の負荷 ——
 * 何件読むか / 何往復するか / 何ミリ秒かかるか —— を切り出して測る。
 * 目的は「表示を速く見せる」ではなく「サーバー処理そのものを短くする」
 * ことなので、まずここを潰すのが順序として正しい。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const SUFFIX = "j6up24p7lnczdmklzjdt3vrp4y-NONE";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-west-2" }));

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ms: number; value: T }> {
  const t0 = Date.now();
  const value = await fn();
  return { label, ms: Date.now() - t0, value };
}

/** 全件スキャン(pagination込み)。実際のアプリの fetchAllInventoryRecords と同じ形。 */
async function scanAll(table: string, projection?: string) {
  let count = 0;
  let pages = 0;
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ProjectionExpression: projection }));
    count += res.Items?.length ?? 0;
    pages++;
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return { count, pages };
}

/** listingPartition GSI を使った1ページだけの取得(在庫一覧の高速経路と同じ形)。 */
async function queryFirstPage(table: string, limit: number) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: table,
      IndexName: "inventoriesByListingPartitionAndListUpdatedAt",
      KeyConditionExpression: "listingPartition = :p",
      ExpressionAttributeValues: { ":p": "ACTIVE" },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return { count: res.Items?.length ?? 0 };
}

async function main() {
  const results: Record<string, unknown>[] = [];

  const inventoryFull = await timed("Inventory 全件スキャン (listInventory / /inventory/listings / /inventory/sales が実行)", () =>
    scanAll(`Inventory-${SUFFIX}`),
  );
  results.push({ label: inventoryFull.label, ms: inventoryFull.ms, ...inventoryFull.value });

  try {
    const page = await timed("Inventory GSI 1ページ50件 (/inventory の高速経路)", () => queryFirstPage(`Inventory-${SUFFIX}`, 50));
    results.push({ label: page.label, ms: page.ms, ...page.value });
  } catch (e) {
    results.push({ label: "Inventory GSI 1ページ", error: e instanceof Error ? e.message : String(e) });
  }

  for (const t of ["Conversation", "Message", "ChannelListing", "ListingDraft", "ShippingRate", "KnowledgeDocument", "BaseProductArchive"]) {
    const r = await timed(`${t} 全件スキャン`, () => scanAll(`${t}-${SUFFIX}`));
    results.push({ label: r.label, ms: r.ms, ...r.value });
  }

  console.log(JSON.stringify(results, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
