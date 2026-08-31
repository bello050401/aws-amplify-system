/**
 * ZAICO実件数とBELLOの実データを突合する。
 *
 * ## なぜ必要か
 *
 * 同期ジョブが COMPLETED になっても、それは「処理を最後まで回した」だけで
 * 「全件が入った」証明ではない。実際 2026-08-31 の全件同期は
 * `status=COMPLETED / totalProcessed=5,312 / missing=0` を報告しながら、
 * BELLO側には 5,311件 しか無かった（1件は create に失敗し、その補償も
 * 失敗して ZaicoSourceLink だけが残っていた）。
 *
 * ジョブの自己申告ではなく、**ZAICO APIの実件数**と**DynamoDBの実データ**を
 * 突き合わせる。ここが一致して初めて「復旧完了」と言える。
 *
 * ## 何も壊さない
 *
 * 読み取り専用。ZAICOのGETとDynamoDBのScan/GetItemしか行わない。
 *
 * ## 使い方
 *
 *   AWS_PROFILE=... BELLO_INVENTORY_TABLE=... BELLO_ZAICO_LINK_TABLE=... \
 *     node scripts/with-server-only-stub.cjs scripts/verify-zaico-reconciliation.ts
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION || process.env.BELLO_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) { passes++; console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failures++; console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

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
  throw new Error(`${model} のテーブルを一意に決められません(候補 ${hits.length}件)。環境変数で明示してください。`);
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

/** ZAICOの全在庫IDを取得する。per_pageは無視されるので、空ページが来るまで進める。 */
async function fetchAllZaicoIds(token: string): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; page <= 200; page++) {
    const res = await fetch(`https://web.zaico.co.jp/api/v1/inventories?page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`ZAICO API ${res.status} (page ${page})`);
    const items = (await res.json()) as Array<{ id: number }>;
    if (!Array.isArray(items) || items.length === 0) break;
    ids.push(...items.map((i) => String(i.id)));
  }
  return ids;
}

async function main(): Promise<void> {
  const invTable = await resolveTable("Inventory", process.env.BELLO_INVENTORY_TABLE);
  const linkTable = await resolveTable("ZaicoSourceLink", process.env.BELLO_ZAICO_LINK_TABLE);
  console.log(`region=${REGION}\ninventory=${invTable}\nlinks=${linkTable}\n`);

  const sm = new SecretsManagerClient({ region: REGION });
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: "bello/zaico-api-token" }));
  const token = JSON.parse(secret.SecretString!).token as string;

  const zaicoIds = await fetchAllZaicoIds(token);
  const zaicoSet = new Set(zaicoIds);
  console.log(`ZAICO API: ${zaicoIds.length}件（ユニーク ${zaicoSet.size}件）`);

  const inventories = await scanAll<{ id: string; sourceSystem?: string; sourceInventoryId?: string; deletedAt?: string }>(
    invTable, "id, sourceSystem, sourceInventoryId, deletedAt",
  );
  const links = await scanAll<{ id: string; sourceInventoryId: string; inventoryId: string }>(
    linkTable, "id, sourceInventoryId, inventoryId",
  );

  const invIds = new Set(inventories.map((i) => i.id));
  const zaicoRows = inventories.filter((i) => i.sourceSystem === "ZAICO" && i.sourceInventoryId && !i.deletedAt);
  const bySource = new Map<string, number>();
  for (const r of zaicoRows) bySource.set(r.sourceInventoryId!, (bySource.get(r.sourceInventoryId!) ?? 0) + 1);

  const duplicates = [...bySource.entries()].filter(([, n]) => n > 1);
  const missing = [...zaicoSet].filter((z) => !bySource.has(z));
  const orphans = [...bySource.keys()].filter((s) => !zaicoSet.has(s));
  const danglingLinks = links.filter((l) => !invIds.has(l.inventoryId));
  const linksWithoutZaico = links.filter((l) => !zaicoSet.has(l.sourceInventoryId));

  // 同期ジョブが「ZAICO側で消えた」と報告した在庫ID。
  //
  // BELLOはZAICOでの削除を追いかけて自動削除しない(schemaのコメント:
  // 「This is reporting only — nothing is ever auto-deleted from BELLO」)。
  // 商品写真・内部メモ・ListingDraft等がZAICO側の操作だけで消えるのを
  // 避けるための設計判断なので、BELLO側に余分な行があること自体は
  // 異常ではない。**異常なのは、それが同期ジョブに把握されていない場合**。
  const jobTable = await resolveTable("ZaicoSyncJob", process.env.BELLO_ZAICO_JOB_TABLE);
  const job = await ddb.send(new GetCommand({ TableName: jobTable, Key: { id: "zaico-full-sync-singleton" } }));
  const reportedMissing: string[] = (job.Item?.missingSourceIds as string[] | undefined) ?? [];
  const jobStatus = (job.Item?.status as string | undefined) ?? "(なし)";
  const unexplained = orphans.filter((o) => !reportedMissing.includes(o));

  console.log(`BELLO: ZAICO由来 ${zaicoRows.length}件 / リンク ${links.length}件 / Inventory全体 ${invIds.size}件\n`);

  // ── 必須条件: ZAICOにある在庫は、すべてBELLOにある ──
  check(missing.length === 0, "欠落なし（ZAICOの全在庫がBELLOに存在する）", missing.length ? missing.slice(0, 10).join(",") : `0件 / ZAICO ${zaicoSet.size}件`);
  check(duplicates.length === 0, "重複なし", duplicates.length ? duplicates.slice(0, 10).map(([k, n]) => `${k}×${n}`).join(",") : "0件");
  check(danglingLinks.length === 0, "宙に浮いたリンクなし（この1件が48824174を永久に取り込めなくしていた）", danglingLinks.length ? danglingLinks.slice(0, 10).map((l) => l.sourceInventoryId).join(",") : "0件");
  check(links.length === zaicoRows.length, "リンク件数とZAICO由来行の件数が一致", `${links.length} / ${zaicoRows.length}`);

  // ── ZAICO側で削除された在庫: 保持は仕様。把握できているかを見る ──
  check(
    unexplained.length === 0,
    "BELLO側の余剰は、すべて同期ジョブが把握している上流削除である",
    unexplained.length ? `未把握 ${unexplained.slice(0, 10).join(",")}` : `未把握 0件（ジョブ報告 ${reportedMissing.length}件）`,
  );

  if (orphans.length > 0) {
    console.log(`
[情報] ZAICO側で削除されたがBELLOに残っている在庫: ${orphans.length}件`);
    console.log(`  ${orphans.slice(0, 20).join(", ")}`);
    console.log("  BELLOはZAICOの削除を追いかけて自動削除しない（商品写真・内部メモ・ListingDraft等を守るため）。");
    console.log(`  直近の同期ジョブ(${jobStatus})も missingSourceIds として同じものを報告している。`);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
