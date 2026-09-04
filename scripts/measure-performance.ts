/**
 * BELLO 性能総点検 — データ層の実測(2026-09-04)。
 *
 *   AWS_PROFILE=Bello npm run measure:performance
 *
 * ── 何を測るのか / 測らないのか ──────────────────────────────────
 *
 * 各画面がサーバー側で実際に行う**読み取りそのもの**を、実Stagingの
 * DynamoDBへ同じ条件で流して時間・往復回数・転送量を測る。
 *
 * 測っているもの:
 *   ・DynamoDB の Query / Scan / GetItem の所要時間
 *   ・1画面あたりの往復回数(これが直列だと画面の待ち時間に直結する)
 *   ::・読み込んだ件数とバイト数
 *   ・AppSync エンドポイントへのネットワーク往復(下限値)
 *   ・Secrets Manager の所要時間
 *
 * **測っていないもの(推測で埋めない)**:
 *   ・AppSync の解決処理そのもの(Cognitoセッションが要るため、この
 *     スクリプトからは呼べない)。ここで出る DynamoDB の時間は
 *     **下限**であって、実際の画面はこれに AppSync の往復が加わる。
 *   ・Amplify SSR(Lambda)の起動時間と React の描画時間。
 *     別途 HTTP 計測とビルド出力から見る。
 *
 * 下限であっても意味がある: 往復回数と走査量は AppSync を挟んでも
 * 変わらず、**そこが桁で効く**。1回30msの読み取りを7回直列に並べれば、
 * AppSync の往復(1回あたり数十ms)が7回分そのまま乗る。
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);
const sm = new SecretsManagerClient({ region: REGION });

/** 各計測の繰り返し回数。1回だけだと接続確立のコストが混ざる。 */
const REPEATS = 3;

interface Measurement {
  /** どの画面の、どの読み取りか。 */
  screen: string;
  label: string;
  /** アクセス方法。Scan は全件走査で、件数に比例して遅くなる。 */
  kind: "Query" | "Scan" | "GetItem" | "Secret" | "Network";
  /** 中央値(ms)。 */
  medianMs: number;
  /** 最小・最大(ms)。ばらつきを隠さない。 */
  minMs: number;
  maxMs: number;
  /** DynamoDBへの往復回数(ページング込み)。 */
  roundTrips: number;
  /** 読み込んだ件数。 */
  items: number;
  /** 読み込んだ概算バイト数。 */
  bytes: number;
  note: string;
}

const results: Measurement[] = [];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function measure(
  screen: string,
  label: string,
  kind: Measurement["kind"],
  run: () => Promise<{ roundTrips: number; items: number; bytes: number; note?: string }>,
): Promise<Measurement> {
  const times: number[] = [];
  let last = { roundTrips: 0, items: 0, bytes: 0, note: "" };
  for (let i = 0; i < REPEATS; i++) {
    const started = performance.now();
    try {
      const r = await run();
      last = { roundTrips: r.roundTrips, items: r.items, bytes: r.bytes, note: r.note ?? "" };
    } catch (err) {
      last = { roundTrips: 0, items: 0, bytes: 0, note: `失敗: ${err instanceof Error ? err.message : String(err)}` };
      times.push(performance.now() - started);
      break;
    }
    times.push(performance.now() - started);
  }
  const m: Measurement = {
    screen,
    label,
    kind,
    medianMs: Math.round(median(times)),
    minMs: Math.round(Math.min(...times)),
    maxMs: Math.round(Math.max(...times)),
    ...last,
  };
  results.push(m);
  console.log(
    `  ${m.medianMs.toString().padStart(6)}ms  ${kind.padEnd(7)} ${label} ` +
      `(往復${m.roundTrips} / ${m.items}件 / ${(m.bytes / 1024).toFixed(0)}KB)${m.note ? ` — ${m.note}` : ""}`,
  );
  return m;
}

/* ── テーブル名の解決 ─────────────────────────────────────────── */

let apiId: string | null = null;
let tableNames: string[] = [];
async function resolveTables(): Promise<void> {
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);
  tableNames = names;
  const required = ["Inventory", "Conversation", "Message", "Category", "ShippingRate", "ListingDraft"];
  const byApi = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(n);
    if (!m) continue;
    if (!byApi.has(m[2])) byApi.set(m[2], new Set());
    byApi.get(m[2])!.add(m[1]);
  }
  const complete = [...byApi.entries()].filter(([, s]) => required.every((r) => s.has(r))).map(([a]) => a);
  if (complete.length !== 1) throw new Error(`Amplify Data APIを一意に決められません(候補${complete.length}件)`);
  apiId = complete[0];
}
function table(model: string): string {
  const hits = tableNames.filter((n) => n.startsWith(`${model}-${apiId}-`));
  if (hits.length !== 1) throw new Error(`${model} のテーブルを一意に決められません`);
  return hits[0];
}

/* ── 共通のアクセスパターン ───────────────────────────────────── */

/** 全件走査。Amplifyの `list({filter})` はこれになる。 */
async function scanAll(
  model: string,
  opts: { filter?: string; names?: Record<string, string>; values?: Record<string, unknown>; projection?: string } = {},
) {
  let roundTrips = 0;
  let items = 0;
  let bytes = 0;
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: table(model),
        ExclusiveStartKey: key,
        ...(opts.filter ? { FilterExpression: opts.filter } : {}),
        ...(opts.names ? { ExpressionAttributeNames: opts.names } : {}),
        ...(opts.values ? { ExpressionAttributeValues: opts.values } : {}),
        ...(opts.projection ? { ProjectionExpression: opts.projection } : {}),
      }),
    );
    roundTrips++;
    items += res.Items?.length ?? 0;
    bytes += JSON.stringify(res.Items ?? []).length;
    key = res.LastEvaluatedKey;
  } while (key);
  return { roundTrips, items, bytes };
}

/** GSIのQuery。ページ数を制限できる(一覧の1ページぶん)。 */
async function queryIndex(
  model: string,
  indexName: string,
  hashKey: string,
  hashValue: unknown,
  opts: { limit?: number; maxPages?: number; scanForward?: boolean; filter?: string; names?: Record<string, string>; values?: Record<string, unknown> } = {},
) {
  let roundTrips = 0;
  let items = 0;
  let bytes = 0;
  let key: Record<string, unknown> | undefined;
  const maxPages = opts.maxPages ?? 100;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table(model),
        IndexName: indexName,
        KeyConditionExpression: "#k = :v",
        ExpressionAttributeNames: { "#k": hashKey, ...(opts.names ?? {}) },
        ExpressionAttributeValues: { ":v": hashValue, ...(opts.values ?? {}) },
        ...(opts.filter ? { FilterExpression: opts.filter } : {}),
        ...(opts.limit ? { Limit: opts.limit } : {}),
        ScanIndexForward: opts.scanForward ?? false,
        ExclusiveStartKey: key,
      }),
    );
    roundTrips++;
    items += res.Items?.length ?? 0;
    bytes += JSON.stringify(res.Items ?? []).length;
    key = res.LastEvaluatedKey;
  } while (key && roundTrips < maxPages && items < (opts.limit ?? 50));
  return { roundTrips, items, bytes };
}

/* ══════════════════════════════════════════════════════════════════
 * 画面ごとの計測
 * ══════════════════════════════════════════════════════════════════ */

/** どの画面でも走る共通部分(マスタ4種)。 */
async function measureMasters(screen: string) {
  await measure(screen, "Category.list(全件走査)", "Scan", () => scanAll("Category"));
  await measure(screen, "Location.list(全件走査)", "Scan", () => scanAll("Location"));
  await measure(screen, "StatusMaster.list(全件走査)", "Scan", () => scanAll("StatusMaster"));
  await measure(screen, "CustomFieldDefinition.list(全件走査)", "Scan", () => scanAll("CustomFieldDefinition"));
}

async function measureInventoryList() {
  console.log("\n■ 在庫一覧");
  await measureMasters("在庫一覧");
  // 既定の一覧。listingPartition GSI の1ページぶん(50件)。
  await measure("在庫一覧", "Inventory GSI(listingPartition, 50件)", "Query", () =>
    queryIndex("Inventory", "inventoriesByListingPartitionAndListUpdatedAt", "listingPartition", "ACTIVE", { limit: 50 }),
  );
  // 検索・詳細検索・GSI失敗時のフォールバックが通る経路。
  await measure("在庫一覧(検索)", "Inventory 全件走査(fetchAllInventoryRecords)", "Scan", () =>
    scanAll("Inventory", {
      filter: "attribute_not_exists(deletedAt)",
    }),
  );
  await measure("在庫一覧", "総件数の集計(全件走査)", "Scan", () =>
    scanAll("Inventory", { filter: "attribute_not_exists(deletedAt)", projection: "id" }),
  );
}

async function measureInventoryDetail(inventoryId: string) {
  console.log("\n■ 商品詳細");
  await measureMasters("商品詳細");
  await measure("商品詳細", "Inventory.get", "GetItem", async () => {
    const res = await ddb.send(new GetCommand({ TableName: table("Inventory"), Key: { id: inventoryId } }));
    return { roundTrips: 1, items: res.Item ? 1 : 0, bytes: JSON.stringify(res.Item ?? {}).length };
  });
  await measure("商品詳細", "InventoryHistory GSI(inventoryId)", "Query", () =>
    queryIndex("InventoryHistory", "inventoryHistoriesByInventoryIdAndChangedAt", "inventoryId", inventoryId, { limit: 200, maxPages: 5 }),
  );
}

async function measureMessages() {
  console.log("\n■ メッセージ");
  await measure("メッセージ", "LINE通知Botの設定(Secrets Manager)", "Secret", async () => {
    try {
      const res = await sm.send(new GetSecretValueCommand({ SecretId: "bello/line-notify-bot" }));
      return { roundTrips: 1, items: 1, bytes: (res.SecretString ?? "").length };
    } catch (err) {
      return { roundTrips: 1, items: 0, bytes: 0, note: `${err instanceof Error ? err.name : "error"}` };
    }
  });
  await measure("メッセージ", "Gmail認証情報(Secrets Manager)", "Secret", async () => {
    try {
      const res = await sm.send(new GetSecretValueCommand({ SecretId: "bello/gmail-oauth" }));
      return { roundTrips: 1, items: 1, bytes: (res.SecretString ?? "").length };
    } catch (err) {
      return { roundTrips: 1, items: 0, bytes: 0, note: `${err instanceof Error ? err.name : "error"}` };
    }
  });
  await measure("メッセージ", "LineNotifySettings(全件走査)", "Scan", () => scanAll("LineNotifySettings"));
  await measure("メッセージ", "ReplyRule.list(全件走査)", "Scan", () => scanAll("ReplyRule"));
  await measure("メッセージ", "NotificationDelivery 直近50件(全件走査)", "Scan", () => scanAll("NotificationDelivery"));
  await measure("メッセージ", "Conversation.list(全件走査)", "Scan", () => scanAll("Conversation"));
}

async function measureListing(inventoryId: string) {
  console.log("\n■ EC出品");
  await measure("EC出品", "Inventory.get", "GetItem", async () => {
    const res = await ddb.send(new GetCommand({ TableName: table("Inventory"), Key: { id: inventoryId } }));
    return { roundTrips: 1, items: res.Item ? 1 : 0, bytes: JSON.stringify(res.Item ?? {}).length };
  });
  await measure("EC出品", "InventoryHistory GSI", "Query", () =>
    queryIndex("InventoryHistory", "inventoryHistoriesByInventoryIdAndChangedAt", "inventoryId", inventoryId, { limit: 200, maxPages: 5 }),
  );
  await measure("EC出品", "ListingDraft GSI(inventoryId)", "Query", () =>
    queryIndex("ListingDraft", "listingDraftsByInventoryId", "inventoryId", inventoryId, { limit: 20, maxPages: 3 }),
  );
  await measure("EC出品", "ChannelListing GSI(inventoryId)", "Query", () =>
    queryIndex("ChannelListing", "channelListingsByInventoryId", "inventoryId", inventoryId, { limit: 20, maxPages: 3 }),
  );
  // 2026-09-04 第2フェーズ§4: 第1フェーズではここに存在しない名前
  // (bello/mercari-api-token)を書いてしまい、ResourceNotFound を
  // 「Secretを作れば直る」と報告していた。アプリが実際に読むのは
  // lib/listing/mercari/secretStore.ts の MERCARI_SECRET_NAME だけなので、
  // 名前を2箇所に書かず、そこから取る。Secretの新規作成は不要。
  const { MERCARI_SECRET_NAME } = await import("@/lib/listing/mercari/secretStore");
  await measure("EC出品", "Mercari TOKEN(Secrets Manager)", "Secret", async () => {
    try {
      const res = await sm.send(new GetSecretValueCommand({ SecretId: MERCARI_SECRET_NAME }));
      return { roundTrips: 1, items: 1, bytes: (res.SecretString ?? "").length };
    } catch (err) {
      return { roundTrips: 1, items: 0, bytes: 0, note: `${err instanceof Error ? err.name : "error"}` };
    }
  });
  await measureMasters("EC出品");
}

async function measureSettings() {
  console.log("\n■ 設定");
  await measureMasters("設定");
  await measure("設定", "ShippingRate(全件走査)", "Scan", () => scanAll("ShippingRate"));
  await measure("設定", "KnowledgeDocument(全件走査)", "Scan", () => scanAll("KnowledgeDocument"));
  await measure("設定", "AIReplySettings(全件走査)", "Scan", () => scanAll("AIReplySettings"));
  await measure("設定", "PricingRule(全件走査)", "Scan", () => scanAll("PricingRule"));
}

async function measureNetworkFloor() {
  console.log("\n■ ネットワークの下限(1往復あたり)");
  const outputs = await import("@/amplify_outputs.json");
  const endpoint = (outputs as { default?: { data?: { url?: string } } }).default?.data?.url;
  if (!endpoint) {
    console.log("  AppSyncのエンドポイントを amplify_outputs.json から読めませんでした。");
    return;
  }
  await measure("共通", `AppSync エンドポイントへの往復(認可前で弾かれる=純粋な往復)`, "Network", async () => {
    const started = performance.now();
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const text = await res.text();
    return { roundTrips: 1, items: 0, bytes: text.length, note: `HTTP ${res.status} / ${Math.round(performance.now() - started)}ms` };
  });
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log(`[measure-performance] ${new Date().toISOString()} region=${REGION}`);
  await resolveTables();
  console.log(`  Amplify Data API: ${apiId}`);

  // 計測に使う在庫を1件選ぶ(履歴が多い行のほうが実態に近い)。
  const sample = await ddb.send(new ScanCommand({ TableName: table("Inventory"), Limit: 1, ProjectionExpression: "id" }));
  const inventoryId = String(sample.Items?.[0]?.id ?? "");
  if (!inventoryId) throw new Error("計測に使う在庫を取得できませんでした。");
  console.log(`  計測対象の在庫: ${inventoryId}`);

  await measureNetworkFloor();
  await measureInventoryList();
  await measureInventoryDetail(inventoryId);
  await measureMessages();
  await measureListing(inventoryId);
  await measureSettings();

  /* ── 画面ごとの合計(直列で行った場合の下限) ────────────────── */
  console.log("\n══ 画面ごとの合計(DynamoDB/Secretsのみ。AppSync・SSR・描画は含まない) ══");
  const byScreen = new Map<string, Measurement[]>();
  for (const m of results) {
    if (m.screen === "共通") continue;
    if (!byScreen.has(m.screen)) byScreen.set(m.screen, []);
    byScreen.get(m.screen)!.push(m);
  }
  for (const [screen, list] of byScreen) {
    const serial = list.reduce((s, m) => s + m.medianMs, 0);
    const trips = list.reduce((s, m) => s + m.roundTrips, 0);
    const bytes = list.reduce((s, m) => s + m.bytes, 0);
    console.log(
      `  ${screen.padEnd(16)} 合計${String(Math.round(serial)).padStart(6)}ms / 往復${String(trips).padStart(3)}回 / ${(bytes / 1024).toFixed(0)}KB`,
    );
  }

  console.log("\n══ 遅い順(中央値) ══");
  for (const m of [...results].sort((a, b) => b.medianMs - a.medianMs).slice(0, 15)) {
    console.log(
      `  ${String(m.medianMs).padStart(6)}ms  [${m.kind}] ${m.screen} / ${m.label} — 往復${m.roundTrips} ${m.items}件 ${(m.bytes / 1024).toFixed(0)}KB`,
    );
  }

  console.log("\n※ ここに出るのは DynamoDB / Secrets Manager の時間だけです。");
  console.log("  実際の画面はこれに AppSync の往復と Amplify SSR(Lambda)の時間、React の描画が加わります。");
}

void main().catch((err) => {
  console.error(`[measure-performance] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
