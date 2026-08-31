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
import { ZAICO_SYNC_JOB_ID } from "@/lib/inventory/zaicoSyncJobId";

const REGION = process.env.AWS_REGION || process.env.BELLO_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) { passes++; console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failures++; console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** ListTablesは1回で全部返るとは限らないので、必ず最後まで辿る。結果は1回だけ取る。 */
let cachedTableNames: string[] | null = null;
async function listAllTableNames(): Promise<string[]> {
  if (cachedTableNames) return cachedTableNames;
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);
  cachedTableNames = names;
  return names;
}

/**
 * Amplify Dataのテーブル名は `<Model>-<apiId>-<branch>` という形をしている。
 * 同じAWSアカウントに過去の(あるいは別ブランチの)Amplifyアプリが残っていると
 * `Inventory-` で始まるテーブルが複数ヒットし、以前はそこで
 * 「一意に決められません」と停止していた —— 実際に2026-09-01時点で
 * `Inventory-4negeddn7navhip2gzxelpl7hq-NONE`(項目数0の残骸)と
 * `Inventory-j6up24p7lnczdmklzjdt3vrp4y-NONE`(本番の5,313件)の2つが存在し、
 * この整合性チェックがまるごと実行できなくなっていた。
 *
 * モデル単体で選ぼうとすると曖昧になるが、**このチェックが必要とする
 * モデルが揃っている apiId は1つしかない** ため、apiIdの単位で選べば
 * 決定的に解決できる(残骸のアプリにはZaicoSourceLinkが存在しない)。
 * 項目数で選ぶような当てずっぽうはしない。
 */
const REQUIRED_MODELS = ["Inventory", "ZaicoSourceLink", "ZaicoSyncJob"] as const;

let cachedApiId: string | null = null;
async function resolveApiId(): Promise<string> {
  if (cachedApiId) return cachedApiId;
  const names = await listAllTableNames();
  /** apiId -> そのapiIdで見つかったモデル名の集合 */
  const byApiId = new Map<string, Set<string>>();
  for (const name of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(name);
    if (!m) continue;
    const [, model, apiId] = m;
    if (!byApiId.has(apiId)) byApiId.set(apiId, new Set());
    byApiId.get(apiId)!.add(model);
  }
  const complete = [...byApiId.entries()].filter(([, models]) => REQUIRED_MODELS.every((m) => models.has(m))).map(([apiId]) => apiId);
  if (complete.length === 1) return (cachedApiId = complete[0]);
  throw new Error(
    `BELLOのAmplify Data APIを一意に決められません(必要なモデル(${REQUIRED_MODELS.join(", ")})が揃っている候補 ${complete.length}件)。` +
      `環境変数 BELLO_INVENTORY_TABLE / BELLO_ZAICO_LINK_TABLE / BELLO_ZAICO_JOB_TABLE で明示してください。`,
  );
}

async function resolveTable(model: string, envValue: string | undefined): Promise<string> {
  if (envValue) return envValue;
  const apiId = await resolveApiId();
  const names = await listAllTableNames();
  const hits = names.filter((n) => n.startsWith(`${model}-${apiId}-`));
  if (hits.length === 1) return hits[0];
  throw new Error(`${model} のテーブルを一意に決められません(apiId=${apiId} の候補 ${hits.length}件)。環境変数で明示してください。`);
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

/**
 * ZAICOの全在庫を取得する。per_pageは無視されるので、空ページが来るまで進める。
 *
 * created_atも一緒に返すのは、「BELLOに無い在庫」が
 * 「取り込みに失敗した(不具合)」のか「直近の同期より後にZAICOへ追加された
 * だけ(正常なラグ)」なのかを区別するため —— 区別しないと、誰かがZAICOへ
 * 商品を1件登録した直後は必ずこの突合が赤くなり、本物の不具合と
 * 見分けが付かなくなる。詳細はmain()の該当箇所のコメントを参照。
 */
async function fetchAllZaicoItems(token: string): Promise<Array<{ id: string; createdAt: string | null }>> {
  const out: Array<{ id: string; createdAt: string | null }> = [];
  for (let page = 1; page <= 200; page++) {
    const res = await fetch(`https://web.zaico.co.jp/api/v1/inventories?page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`ZAICO API ${res.status} (page ${page})`);
    const items = (await res.json()) as Array<{ id: number; created_at?: string }>;
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items.map((i) => ({ id: String(i.id), createdAt: i.created_at ?? null })));
  }
  return out;
}

async function main(): Promise<void> {
  const invTable = await resolveTable("Inventory", process.env.BELLO_INVENTORY_TABLE);
  const linkTable = await resolveTable("ZaicoSourceLink", process.env.BELLO_ZAICO_LINK_TABLE);
  console.log(`region=${REGION}\ninventory=${invTable}\nlinks=${linkTable}\n`);

  const sm = new SecretsManagerClient({ region: REGION });
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: "bello/zaico-api-token" }));
  const token = JSON.parse(secret.SecretString!).token as string;

  const zaicoItems = await fetchAllZaicoItems(token);
  const zaicoIds = zaicoItems.map((i) => i.id);
  const zaicoSet = new Set(zaicoIds);
  const zaicoCreatedAt = new Map(zaicoItems.map((i) => [i.id, i.createdAt] as const));
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
  const job = await ddb.send(new GetCommand({ TableName: jobTable, Key: { id: ZAICO_SYNC_JOB_ID } }));

  // ZaicoSyncJob は設計上ちょうど1行。lease/heartbeat による排他制御が
  // その前提に立っている。行が増えると2つの実行主体が別々の行を見て
  // 互いのleaseを無視することになるうえ、余分な行が PENDING のままだと
  // UIが「同期実行中」と表示し続ける。
  //
  // 実際に運用作業でidを取り違えて余分な行を作ってしまったことがある
  // (2026-08-31)。そのときは気付くまでに時間がかかったので、突合で
  // 一目で分かるようにした。
  const jobRows = await scanAll<{ id: string }>(jobTable, "id");
  const strayJobs = jobRows.filter((r) => r.id !== ZAICO_SYNC_JOB_ID);
  const reportedMissing: string[] = (job.Item?.missingSourceIds as string[] | undefined) ?? [];
  const jobStatus = (job.Item?.status as string | undefined) ?? "(なし)";
  const unexplained = orphans.filter((o) => !reportedMissing.includes(o));

  console.log(`BELLO: ZAICO由来 ${zaicoRows.length}件 / リンク ${links.length}件 / Inventory全体 ${invIds.size}件\n`);

  // ── 必須条件: ZAICOにある在庫は、すべてBELLOにある ──
  //
  // ただし「直近の同期が終わった後にZAICOへ追加された在庫」は、まだ
  // BELLOに無くて当然であり不具合ではない(次の同期で入る)。両者を
  // 区別せずに落とすと、誰かがZAICOへ1件登録しただけでこの突合が赤くなり、
  // 本物の取り込み失敗と見分けが付かなくなる —— 2026-09-01の実行が
  // まさにそれで、73729844(ZAICOでの作成 2026-09-01T00:04:37+09:00)が
  // 直近同期の完了(2026-08-31T12:12:19Z)より後だったために落ちていた。
  //
  // これは判定を緩めているのではなく、逆に厳しくしている: 「同期完了より
  // 前から存在するのにBELLOに無い」は、以前の1,000件打ち切りや
  // 宙に浮いたリンクのような**取り込み不具合そのもの**であり、
  // ラグでは説明できない。そこだけを失敗として扱う。
  const syncFinishedAt = (job.Item?.finishedAt as string | undefined) ?? null;
  const syncFinishedMs = syncFinishedAt ? Date.parse(syncFinishedAt) : NaN;
  const missingCreatedAfterSync: string[] = [];
  const missingDespiteSync: string[] = [];
  for (const id of missing) {
    const createdAt = zaicoCreatedAt.get(id) ?? null;
    const createdMs = createdAt ? Date.parse(createdAt) : NaN;
    // 作成時刻が読めない場合は安全側(=不具合候補)へ倒す。
    if (Number.isFinite(syncFinishedMs) && Number.isFinite(createdMs) && createdMs > syncFinishedMs) missingCreatedAfterSync.push(id);
    else missingDespiteSync.push(id);
  }

  check(
    missingDespiteSync.length === 0,
    "欠落なし（直近同期の時点で存在したZAICO在庫は、すべてBELLOにある）",
    missingDespiteSync.length ? missingDespiteSync.slice(0, 10).join(",") : `0件 / ZAICO ${zaicoSet.size}件`,
  );

  if (missingCreatedAfterSync.length > 0) {
    console.log(`
[情報] 直近同期(${syncFinishedAt})より後にZAICOへ追加され、まだBELLOに無い在庫: ${missingCreatedAfterSync.length}件`);
    console.log(`  ${missingCreatedAfterSync.slice(0, 20).join(", ")}`);
    console.log("  次回の同期で取り込まれる想定。取り込まれない場合は不具合として扱う。");
  }
  check(duplicates.length === 0, "重複なし", duplicates.length ? duplicates.slice(0, 10).map(([k, n]) => `${k}×${n}`).join(",") : "0件");
  check(danglingLinks.length === 0, "宙に浮いたリンクなし（この1件が48824174を永久に取り込めなくしていた）", danglingLinks.length ? danglingLinks.slice(0, 10).map((l) => l.sourceInventoryId).join(",") : "0件");
  check(links.length === zaicoRows.length, "リンク件数とZAICO由来行の件数が一致", `${links.length} / ${zaicoRows.length}`);

  // ── ZAICO側で削除された在庫: 保持は仕様。把握できているかを見る ──
  check(
    jobRows.length === 1 && strayJobs.length === 0,
    "ZaicoSyncJobがちょうど1行（idの取り違えで余分な行を作っていない）",
    strayJobs.length ? `想定外のid: ${strayJobs.map((r) => r.id).join(",")}` : `${jobRows.length}行 / id=${ZAICO_SYNC_JOB_ID}`,
  );

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
