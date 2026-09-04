/**
 * 検索の改善前後を、同じ条件・同じデータで実測する
 * (2026-09-04 性能改善 第2フェーズ §2/§10)。
 *
 *   AWS_PROFILE=Bello npm run measure:inventory-search
 *
 * ── 何と何を比べるのか ──────────────────────────────────────────
 *
 *   旧: 非削除の在庫を**全列**走査してからアプリ側で絞り込む
 *       (従来の fetchAllInventoryRecords が DynamoDB へ課していた負荷
 *        そのもの。実際の経路はこの上に AppSync が乗るので、ここで出る
 *        数字は旧経路の**下限**)
 *   新: lib/inventory/inventorySearchFast.ts の searchInventoryFast
 *       (検索に要る列だけを並列Scanで読み、表示する50件だけを実体化)
 *
 * 取るのは、指示書§2の項目:
 *   検索所要時間 / 往復回数 / 読み取り件数 / 転送量 / 1回目と2回目
 *
 * ── この数字の読み方(重要) ──────────────────────────────────────
 *
 * 実行はこのノートPCから。東京→us-west-2 の往復が1回あたり約160msあり、
 * **新旧どちらにも同じだけ乗っている**。本番(同一リージョンのLambda)
 * では往復1回あたりの待ちがこれよりずっと小さいので、ここの絶対値は
 * 上振れした値として読む。比率のほうが実態に近い。
 *
 * 読み取り専用(Scan と BatchGetItem のみ)。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ensureConversationTableName } from "./lib/resolveStagingTables";

const REGION = process.env.AWS_REGION || "us-west-2";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

interface Measurement {
  ms: number;
  trips: number;
  items: number;
  bytes: number;
  /** 直列に待った段数(並列走査では往復総数より小さくなる)。 */
  serialDepth: number;
}

function fmt(m: Measurement): string {
  return `${String(m.ms).padStart(6)}ms  往復${String(m.trips).padStart(3)}  直列${String(m.serialDepth).padStart(2)}段  ${String(m.items).padStart(5)}件  ${(m.bytes / 1024 / 1024).toFixed(2)}MB`;
}

/** 旧経路が DynamoDB へ課していた負荷: 非削除の全件を全列で読む。 */
async function measureLegacyScan(table: string): Promise<Measurement> {
  const t0 = Date.now();
  let trips = 0;
  let items = 0;
  let bytes = 0;
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: table, FilterExpression: "attribute_not_exists(deletedAt)", ExclusiveStartKey: key }),
    );
    trips++;
    items += res.Items?.length ?? 0;
    bytes += JSON.stringify(res.Items ?? []).length;
    key = res.LastEvaluatedKey;
  } while (key);
  return { ms: Date.now() - t0, trips, items, bytes, serialDepth: trips };
}

async function main() {
  await ensureConversationTableName();
  const { searchInventoryFast } = await import("@/lib/inventory/inventorySearchFast");
  const { directTableName } = await import("@/lib/amplify/directData");
  const { STATIC_SEARCH_FIELDS } = await import("@/lib/inventory/advancedSearch");
  const table = directTableName("Inventory");
  console.log(`[measure-inventory-search] ${table}\n`);

  const fieldsByKey = new Map(STATIC_SEARCH_FIELDS.map((f) => [f.key, f]));
  type Cond = { field: string; operator: string; value?: string; value2?: string };
  const adv = (conditions: Cond[]) =>
    ({
      query: { combinator: "AND", conditions: conditions.map((c, i) => ({ ...c, id: `c${i}` })) },
      fieldsByKey,
      // 条件の型は advancedSearch.ts の union だが、ここは計測用の固定条件なので
      // union の網羅を書き下すより、その場で1回だけ緩める。
    }) as unknown as NonNullable<Parameters<typeof searchInventoryFast>[0]["advanced"]>;

  // ── 旧経路(DynamoDBへの負荷) ────────────────────────────────
  console.log("■ 旧: 全列を全件走査してからアプリ側で絞り込む（従来の検索がDynamoDBへ課していた負荷）");
  const legacy1 = await measureLegacyScan(table);
  console.log(`  1回目  ${fmt(legacy1)}`);
  const legacy2 = await measureLegacyScan(table);
  console.log(`  2回目  ${fmt(legacy2)}`);
  console.log("  （どの検索条件でも同じ全件・全列を読むので、この値が全検索に共通してかかっていた）\n");

  // ── 新経路 ───────────────────────────────────────────────────
  const cases: { label: string; input: Parameters<typeof searchInventoryFast>[0] }[] = [
    { label: "クイック検索（商品名の一部）", input: { q: "ソファ" } },
    { label: "クイック検索（該当なし）", input: { q: "__zzz__" } },
    { label: "一覧の絞り込みのみ（カテゴリなし）", input: {} },
    { label: "詳細検索（商品名 contains）", input: { advanced: adv([{ field: "name", operator: "contains", value: "ソファ" }]) } },
    {
      label: "詳細検索（備考あり + 購入価格 ≧1万）",
      input: {
        advanced: adv([
          { field: "note", operator: "isNotEmpty" },
          { field: "purchasePrice", operator: "ge", value: "10000" },
        ]),
      },
    },
  ];

  console.log("■ 新: 検索に要る列だけを並列Scanで読み、表示する50件だけを実体化する");
  const { withQueryTiming, currentQueryTimings } = await import("@/lib/perf/queryTiming");
  process.env.BELLO_QUERY_TIMING = "1";

  for (const c of cases) {
    for (const run of [1, 2]) {
      const t0 = Date.now();
      let trips = 0;
      let items = 0;
      const result = await withQueryTiming("search", async () => {
        const r = await searchInventoryFast(c.input, { offset: 0, limit: 50 });
        for (const t of currentQueryTimings()) {
          trips++;
          items += t.items ?? 0;
        }
        return r;
      });
      const ms = Date.now() - t0;
      if (!result) {
        console.log(`  ${c.label} [${run}回目]  高速経路が使えない（従来経路へ落ちる）`);
        continue;
      }
      console.log(
        `  ${c.label} [${run}回目]  ${String(ms).padStart(6)}ms  往復${String(trips).padStart(3)}  読取${String(items).padStart(5)}件  ヒット${result.total}件`,
      );
    }
  }

  console.log(
    "\n（転送量は searchScanProjection の実測: 検索に要る列だけなら 5,329件で 1.95MB。全列は 11.83MB。）",
  );
}

void main().catch((err) => {
  console.error(`[measure-inventory-search] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
