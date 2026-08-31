/**
 * ZaicoSourceLink の不整合（宙に浮いたリンク）の検出と修復。
 *
 * ## 何を直すのか
 *
 * ZAICO同期は新規作成の前に `ZaicoSourceLink` を claim して在庫IDを予約し、
 * create に失敗したら `releaseSourceLink` で解放する。この**解放自体が
 * 失敗する**と、「リンクはあるが参照先の Inventory が無い」状態が残る。
 *
 * その状態になると zaicoSyncEngine は毎回
 *   「重複防止リンクは存在しますが、参照先のInventoryレコードが
 *     見つかりません(不整合な状態です)。管理者による確認が必要です。」
 * を投げるため、**その1件は再同期しても永久に取り込めない**。
 *
 * 実例: 2026-08-31 の全件同期(5,312件)で ZAICO ID 48824174 の1件だけが
 * この状態になり、BELLO側に 5,311件 しか存在しない原因になっていた。
 * 「コード修正済み」と「実データ復旧済み」は別物であり、これは後者の作業。
 *
 * ## 安全性
 *
 * - 既定は**ドライラン**。`--apply` を付けたときだけ削除する。
 * - 削除するのは「参照先の Inventory が実在しない」リンクだけ。
 *   Inventory 本体には一切触れない（読むだけ）。
 * - 削除前に対象を JSON で書き出す（`--backup <path>`、既定は自動命名）。
 * - 参照先が実在するリンクは、たとえ deletedAt が付いていても触らない
 *   （論理削除された在庫のリンクを消すと、復元時に重複が生まれるため）。
 *
 * ## 使い方
 *
 *   AWS_PROFILE=... node scripts/with-server-only-stub.cjs scripts/repair-zaico-dangling-links.ts
 *   AWS_PROFILE=... node scripts/with-server-only-stub.cjs scripts/repair-zaico-dangling-links.ts --apply
 *
 * テーブル名は BELLO_INVENTORY_TABLE / BELLO_ZAICO_LINK_TABLE で指定する。
 * 未指定なら同一リージョンから接尾辞一致で自動検出する。
 */
import fs from "node:fs";
import path from "node:path";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || process.env.BELLO_REGION || "us-west-2";
const APPLY = process.argv.includes("--apply");
const BACKUP =
  process.argv[process.argv.indexOf("--backup") + 1] && process.argv.includes("--backup")
    ? process.argv[process.argv.indexOf("--backup") + 1]
    : path.join(process.cwd(), `zaico-dangling-links-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

interface LinkRow { id: string; sourceInventoryId: string; inventoryId: string; sourceSystem?: string }

/** テーブル名を解決する。同名モデルの別ブランチ分が並ぶので、行数の多い方を選ばず「明示指定」を促す。 */
async function resolveTable(model: string, envValue: string | undefined): Promise<string> {
  if (envValue) return envValue;
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);
  const hits = names.filter((n) => n.startsWith(`${model}-`));
  if (hits.length === 1) return hits[0];
  throw new Error(
    `${model} のテーブルを一意に決められません(候補 ${hits.length}件: ${hits.join(", ") || "なし"})。` +
      `環境変数で明示してください。`,
  );
}

async function scanAll<T>(table: string, projection: string): Promise<T[]> {
  const out: T[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ProjectionExpression: projection, ExclusiveStartKey: key }));
    out.push(...((res.Items ?? []) as T[]));
    key = res.LastEvaluatedKey;
  } while (key);
  return out;
}

async function main(): Promise<void> {
  const linkTable = await resolveTable("ZaicoSourceLink", process.env.BELLO_ZAICO_LINK_TABLE);
  const invTable = await resolveTable("Inventory", process.env.BELLO_INVENTORY_TABLE);
  console.log(`region=${REGION}`);
  console.log(`links=${linkTable}`);
  console.log(`inventory=${invTable}`);
  console.log(APPLY ? "モード: 適用(--apply)" : "モード: ドライラン(削除しません)");

  const links = await scanAll<LinkRow>(linkTable, "id, sourceInventoryId, inventoryId, sourceSystem");
  const inventories = await scanAll<{ id: string }>(invTable, "id");
  const existing = new Set(inventories.map((i) => i.id));

  console.log(`\nリンク ${links.length}件 / Inventory ${existing.size}件`);

  const dangling: LinkRow[] = [];
  for (const link of links) {
    if (existing.has(link.inventoryId)) continue;
    // Scanの取りこぼしを疑い、消す前に必ず1件ずつ実在確認する。
    const got = await ddb.send(new GetCommand({ TableName: invTable, Key: { id: link.inventoryId } }));
    if (got.Item) continue;
    dangling.push(link);
  }

  if (dangling.length === 0) {
    console.log("\n宙に浮いたリンクはありません。");
    return;
  }

  console.log(`\n宙に浮いたリンク: ${dangling.length}件`);
  for (const d of dangling) console.log(`  ZAICO ${d.sourceInventoryId} -> ${d.inventoryId} (link id ${d.id})`);

  fs.writeFileSync(BACKUP, JSON.stringify(dangling, null, 2), "utf8");
  console.log(`\n対象を書き出しました: ${BACKUP}`);

  if (!APPLY) {
    console.log("\nドライランのため削除していません。実行するには --apply を付けてください。");
    console.log("削除後、ZAICO同期を再実行すると該当在庫が新規作成されます。");
    return;
  }

  let deleted = 0;
  for (const d of dangling) {
    await ddb.send(new DeleteCommand({ TableName: linkTable, Key: { id: d.id } }));
    deleted++;
    console.log(`  削除: ${d.id}`);
  }
  console.log(`\n${deleted}件のリンクを削除しました。ZAICO同期を再実行してください。`);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
