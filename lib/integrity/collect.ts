/**
 * 整合性の指標を実データから数える（2026-09-04 最終フェーズ Phase B）。
 *
 * **読み取りしかしない。** 修復・削除・統合は一切行わない。
 *
 * CLI（scripts/verify-data-integrity.ts）と、日次のLambda
 * （amplify/functions/integrity-monitor）の**両方がこの1本を使う**。
 * 2箇所に同じ数え方を書くと、片方だけ直った日に「監視は正常なのに
 * 手元で見ると異常」という一番たちの悪いずれ方をする。
 *
 * ── 失敗を0にしない ────────────────────────────────────────────
 *
 * 走査が失敗した指標は `value: null` と理由を返す。0を返すと、
 * lib/integrity/compare.ts 側で「異常が消えた」と誤って基準値を
 * 書き換えてしまう。取得の失敗と0件は別物。
 *
 * ── 依存を引数で受け取る ────────────────────────────────────────
 *
 * DynamoDBのクライアントとテーブル名解決を引数で受ける。server-only の
 * モジュールを引き込まないので、Lambdaのバンドルにも素直に入る。
 */
import { ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { IntegrityMetric } from "./compare";

/** 並列Scanのセグメント数（lib/inventory/inventorySearchFast.ts と同じ理由）。 */
const SEGMENTS = 8;
/** 途中状態を「止まっている」とみなすまでの時間。どの処理も通常は数分で終わる。 */
const STUCK_AFTER_MS = 60 * 60 * 1000;

export interface CollectDeps {
  ddb: DynamoDBDocumentClient;
  /** モデル名 → 実テーブル名。 */
  tableFor: (model: string) => string;
  /** 「今」。テストから固定できるようにする。 */
  now?: () => number;
}

export interface CollectResult {
  metrics: IntegrityMetric[];
  /** 人が読むための補足（件数だけでは原因が分からないため）。 */
  details: { key: string; examples: string[] }[];
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

async function scanAll(deps: CollectDeps, model: string, attrs: string[]): Promise<Row[]> {
  const names: Record<string, string> = {};
  const proj = attrs.map((a, i) => {
    names[`#a${i}`] = a;
    return `#a${i}`;
  });
  const segment = async (seg: number) => {
    const out: Row[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const res = await deps.ddb.send(
        new ScanCommand({
          TableName: deps.tableFor(model),
          Segment: seg,
          TotalSegments: SEGMENTS,
          ProjectionExpression: proj.join(", "),
          ExpressionAttributeNames: names,
          ExclusiveStartKey: key,
        }),
      );
      out.push(...((res.Items ?? []) as Row[]));
      key = res.LastEvaluatedKey;
    } while (key);
    return out;
  };
  const parts = await Promise.all(Array.from({ length: SEGMENTS }, (_, i) => segment(i)));
  return parts.flat();
}

function countOrphans(rows: Row[], refField: string, known: Set<string>): { count: number; examples: string[] } {
  const bad: string[] = [];
  for (const r of rows) {
    const ref = str(r[refField]);
    if (ref && !known.has(ref)) bad.push(`id=${String(r.id)} ${refField}=${ref}`);
  }
  return { count: bad.length, examples: bad.slice(0, 5) };
}

function countDuplicates(rows: Row[], field: string): { count: number; examples: string[] } {
  const byValue = new Map<string, string[]>();
  for (const r of rows) {
    const v = str(r[field]);
    if (!v) continue;
    const list = byValue.get(v);
    if (list) list.push(String(r.id));
    else byValue.set(v, [String(r.id)]);
  }
  const dups = [...byValue.entries()].filter(([, ids]) => ids.length > 1);
  return { count: dups.length, examples: dups.slice(0, 5).map(([v, ids]) => `${field}=${v} → ${ids.length}件`) };
}

/**
 * 1指標ぶんを安全に測る。
 *
 * 中の走査が落ちても他の指標まで巻き込まない。落ちた指標は value:null で
 * 返し、呼び出し側が「取得できなかった」として扱う。
 */
async function safely(
  key: string,
  label: string,
  run: () => Promise<{ count: number; examples: string[] }>,
): Promise<{ metric: IntegrityMetric; detail: { key: string; examples: string[] } }> {
  try {
    const { count, examples } = await run();
    return { metric: { key, label, value: count }, detail: { key, examples } };
  } catch (err) {
    const reason = err instanceof Error ? err.name : "unknown";
    return { metric: { key, label, value: null, error: reason }, detail: { key, examples: [] } };
  }
}

export async function collectIntegrityMetrics(deps: CollectDeps): Promise<CollectResult> {
  const now = (deps.now ?? Date.now)();
  const isStale = (v: unknown) => {
    const t = Date.parse(str(v) ?? "");
    return Number.isFinite(t) && now - t > STUCK_AFTER_MS;
  };

  // 在庫は多くの指標の土台になるので、最初に1回だけ読む。
  // ここが落ちたら、それに依存する指標もすべて「取得できなかった」になる。
  let live: Row[] | null = null;
  let liveIds: Set<string> = new Set();
  let inventoryError: string | null = null;
  try {
    const inventory = await scanAll(deps, "Inventory", [
      "id",
      "sku",
      "sourceSystem",
      "sourceInventoryId",
      "listingPartition",
      "deletedAt",
    ]);
    live = inventory.filter((r) => !str(r.deletedAt));
    liveIds = new Set(live.map((r) => String(r.id)));
  } catch (err) {
    inventoryError = err instanceof Error ? err.name : "unknown";
  }

  const needInventory = <T>(run: (rows: Row[], ids: Set<string>) => Promise<T>) => async (): Promise<T> => {
    if (live === null) throw new Error(inventoryError ?? "在庫を読めませんでした");
    return run(live, liveIds);
  };

  const results = await Promise.all([
    safely(
      "inventoryMissingListingPartition",
      "listingPartition の無い在庫（一覧に出てこない）",
      needInventory(async (rows) => {
        const bad = rows.filter((r) => !str(r.listingPartition));
        return { count: bad.length, examples: bad.slice(0, 5).map((r) => `id=${String(r.id)}`) };
      }),
    ),
    safely("dupInventorySku", "SKUの重複", needInventory(async (rows) => countDuplicates(rows, "sku"))),
    safely(
      "dupInventoryZaicoSourceId",
      "同じZAICO在庫IDの在庫（重複同期）",
      needInventory(async (rows) => countDuplicates(rows.filter((r) => str(r.sourceSystem) === "ZAICO"), "sourceInventoryId")),
    ),
    safely(
      "orphanHistoryInventories",
      "削除記録の無い在庫を指す履歴（在庫数）",
      needInventory(async (_rows, ids) => {
        const history = await scanAll(deps, "InventoryHistory", ["id", "inventoryId", "fieldName"]);
        const orphan = new Set<string>();
        const deleted = new Set<string>();
        for (const r of history) {
          const ref = str(r.inventoryId);
          if (!ref) continue;
          if (str(r.fieldName) === "削除") deleted.add(ref);
          if (!ids.has(ref)) orphan.add(ref);
        }
        const unexplained = [...orphan].filter((id) => !deleted.has(id));
        return { count: unexplained.length, examples: unexplained.slice(0, 5).map((id) => `inventoryId=${id}`) };
      }),
    ),
    ...(
      [
        ["orphanListingDrafts", "存在しない在庫を指す出品下書き", "ListingDraft", "inventoryId"],
        ["orphanChannelListings", "存在しない在庫を指すチャネル出品", "ChannelListing", "inventoryId"],
        ["orphanProcessingJobs", "存在しない在庫を指す画像処理ジョブ", "ProcessingJob", "inventoryId"],
        ["orphanImageVersions", "存在しない在庫を指す画像処理履歴", "ImageProcessingVersion", "inventoryId"],
        ["orphanZaicoSourceLinks", "存在しない在庫を指すZAICO連携リンク", "ZaicoSourceLink", "inventoryId"],
        ["orphanMercariOrderContexts", "存在しない在庫を指すメルカリ注文コンテキスト", "MercariOrderContext", "inventoryId"],
        ["orphanConversationInventory", "存在しない在庫を指す会話", "Conversation", "relatedInventoryId"],
      ] as const
    ).map(([key, label, model, field]) =>
      safely(
        key,
        label,
        needInventory(async (_rows, ids) => countOrphans(await scanAll(deps, model, ["id", field]), field, ids)),
      ),
    ),
  ]);

  // 会話・メッセージ・通知は在庫に依存しないので独立して測る。
  let conversationIds: Set<string> | null = null;
  let conversationError: string | null = null;
  try {
    const conversations = await scanAll(deps, "Conversation", ["id"]);
    conversationIds = new Set(conversations.map((r) => String(r.id)));
  } catch (err) {
    conversationError = err instanceof Error ? err.name : "unknown";
  }
  const needConversations = <T>(run: (ids: Set<string>) => Promise<T>) => async (): Promise<T> => {
    if (conversationIds === null) throw new Error(conversationError ?? "会話を読めませんでした");
    return run(conversationIds);
  };

  const messaging = await Promise.all([
    safely(
      "orphanMessages",
      "存在しない会話を指すメッセージ",
      needConversations(async (ids) => countOrphans(await scanAll(deps, "Message", ["id", "conversationId"]), "conversationId", ids)),
    ),
    safely("dupMessageExternalId", "同じexternalMessageIdのメッセージ（受信の二重登録）", async () =>
      countDuplicates(await scanAll(deps, "Message", ["id", "externalMessageId"]), "externalMessageId"),
    ),
    safely("dupNotificationDedupeKey", "同じdedupeKeyの通知（LINEへの二重送信）", async () =>
      countDuplicates(await scanAll(deps, "NotificationDelivery", ["id", "dedupeKey"]), "dedupeKey"),
    ),
    safely(
      "orphanNotificationConversation",
      "存在しない会話を指す通知",
      needConversations(async (ids) =>
        countOrphans(await scanAll(deps, "NotificationDelivery", ["id", "conversationId"]), "conversationId", ids),
      ),
    ),
  ]);

  const stuck = await Promise.all(
    (
      [
        ["stuckNotifications", "PROCESSING のまま止まっている通知", "NotificationDelivery", ["PROCESSING"], "updatedAt"],
        ["stuckZaicoJobs", "RUNNING のまま止まっているZAICO同期", "ZaicoSyncJob", ["RUNNING"], "updatedAt"],
        ["stuckProcessingJobs", "PROCESSING のまま止まっている画像処理", "ProcessingJob", ["PROCESSING"], "updatedAt"],
        ["stuckListingDrafts", "PUBLISHING/QUEUED のまま止まっている出品下書き", "ListingDraft", ["PUBLISHING", "QUEUED"], "updatedAt"],
      ] as const
    ).map(([key, label, model, statuses, timeField]) =>
      safely(key, label, async () => {
        const rows = await scanAll(deps, model, ["id", "status", timeField]);
        const bad = rows.filter((r) => (statuses as readonly string[]).includes(str(r.status) ?? "") && isStale(r[timeField]));
        return { count: bad.length, examples: bad.slice(0, 5).map((r) => `id=${String(r.id)} status=${String(r.status)}`) };
      }),
    ),
  );

  const all = [...results, ...messaging, ...stuck];
  return { metrics: all.map((r) => r.metric), details: all.map((r) => r.detail) };
}
