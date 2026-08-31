import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { listInventories } from "./zaicoApiClient";
import { createLambdaSyncPort, findMissingZaicoManagedInventory } from "./lambdaSyncPort";
import { syncOneZaicoItem } from "@/lib/inventory/zaicoSyncEngine";
import type { MasterCache } from "@/lib/inventory/zaicoSyncPorts";
import { ZAICO_SYNC_JOB_ID } from "../../../lib/inventory/zaicoSyncJobId";

/**
 * BELLO統合業務OS 第五ラウンド §4(P0-A): ZAICO同期の完全無人worker。
 * resource.tsのコメント参照。ZaicoSyncJobの既存singleton行
 * (lib/inventory/zaicoBackgroundSync.tsが定義するのと全く同じid/
 * フィールド)をそのまま共有する——ブラウザ側の「今すぐ少し進める」
 * advance操作とこのLambdaのスケジュール実行は、同じjob行をlease機構
 * で安全に排他する。
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ZAICO_SYNC_JOB_TABLE = process.env.ZAICO_SYNC_JOB_TABLE_NAME!;
const JOB_ID = ZAICO_SYNC_JOB_ID;
const ITEMS_PER_PAGE = 50;
const LEASE_DURATION_MS = 4 * 60 * 1000; // 4分——Lambda自体のtimeout(240秒)より短く、他の実行主体が「lease切れ」と判定できる猶予を作る
const TIME_BUDGET_MS = 210_000; // 240秒timeoutに対し、最後のcheckpoint書き込み分の余裕を30秒残す
const MAX_RETRIES_BEFORE_FAILED = 5;

const OWNER_ID = `lambda:${randomUUID().slice(0, 8)}`;

function parseSeenSourceIds(raw: unknown): Set<string> {
  if (typeof raw === "string") {
    try {
      return parseSeenSourceIds(JSON.parse(raw));
    } catch {
      return new Set();
    }
  }
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

interface JobRow {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  lastPage?: number;
  totalProcessed?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  failed?: number;
  imageImported?: number;
  seenSourceIds?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  retryCount?: number;
}

async function getJob(): Promise<JobRow | null> {
  const { Item } = await ddb.send(new GetCommand({ TableName: ZAICO_SYNC_JOB_TABLE, Key: { id: JOB_ID } }));
  return (Item as JobRow | undefined) ?? null;
}

/**
 * lease確保。既にleaseOwnerが別の主体(自分以外)で、かつまだ有効期限内
 * なら失敗(false)を返す——ブラウザ側のadvanceZaicoBackgroundSyncJobが
 * ちょうど同じjobを処理中なら、このLambda実行は今回何もせず終了する
 * (次の5分後に再挑戦、コストは1回のGetItem+条件付きUpdateItemのみ)。
 */
async function claimOrRenewLease(): Promise<boolean> {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ZAICO_SYNC_JOB_TABLE,
        Key: { id: JOB_ID },
        UpdateExpression: "SET leaseOwner = :owner, leaseExpiresAt = :expires, lastHeartbeatAt = :now",
        ConditionExpression: "attribute_not_exists(leaseOwner) OR leaseExpiresAt < :nowStr OR leaseOwner = :owner",
        ExpressionAttributeValues: { ":owner": OWNER_ID, ":expires": leaseExpiresAt, ":now": now, ":nowStr": now },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** 自分が保持しているleaseだけを解放する(他の実行主体が既に新しいleaseを確保していたら誤って奪わないよう、ConditionExpressionでowner一致を確認)。 */
async function releaseLease(): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ZAICO_SYNC_JOB_TABLE,
        Key: { id: JOB_ID },
        UpdateExpression: "REMOVE leaseOwner, leaseExpiresAt",
        ConditionExpression: "leaseOwner = :owner",
        ExpressionAttributeValues: { ":owner": OWNER_ID },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") console.error("[zaico-sync-worker] failed to release lease (non-fatal):", err);
  }
}

async function writeCheckpoint(fields: Record<string, unknown>): Promise<void> {
  const names = Object.fromEntries(Object.keys(fields).map((k, i) => [`#f${i}`, k]));
  const values = Object.fromEntries(Object.values(fields).map((v, i) => [`:v${i}`, v]));
  const setClause = Object.keys(fields).map((_, i) => `#f${i} = :v${i}`).join(", ");
  await ddb.send(new UpdateCommand({ TableName: ZAICO_SYNC_JOB_TABLE, Key: { id: JOB_ID }, UpdateExpression: `SET ${setClause}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
}

export const handler = async () => {
  const job = await getJob();
  if (!job || (job.status !== "PENDING" && job.status !== "RUNNING")) {
    return { skipped: true, reason: "no PENDING/RUNNING job" };
  }

  const claimed = await claimOrRenewLease();
  if (!claimed) {
    console.log("[zaico-sync-worker] lease held by another executor (browser tab or overlapping invocation) — skipping this tick.");
    return { skipped: true, reason: "lease held elsewhere" };
  }

  const startTime = Date.now();
  const port = createLambdaSyncPort();

  let nextPage = (job.lastPage ?? 0) + 1;
  const seenSourceIds = parseSeenSourceIds(job.seenSourceIds);
  const counts = {
    totalProcessed: job.totalProcessed ?? 0,
    created: job.created ?? 0,
    updated: job.updated ?? 0,
    unchanged: job.unchanged ?? 0,
    failed: job.failed ?? 0,
    imageImported: job.imageImported ?? 0,
  };

  let pagesThisRun = 0;
  try {
    for (;;) {
      // §14.3(第五ラウンド仕様): チェックポイント/status write自体が
      // ボトルネックにならない粒度——ページ単位(最大50件)で1回だけ。
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        console.log(`[zaico-sync-worker] time budget reached after ${pagesThisRun} page(s) this invocation — yielding to next scheduled tick.`);
        break;
      }

      // §30.7で確立したprefetch+masterCache最適化をLambda側でも同様に
      // ページ毎1回適用する(browser側のadvanceZaicoBackgroundSyncJobと
      // 全く同じパターン)。
      const prefetched = await port.fetchAllZaicoManaged();
      const masterCache: MasterCache = { categories: new Map(), locations: new Map() };

      const { items: zaicoItems, hasMore } = await listInventories(nextPage, ITEMS_PER_PAGE);

      // leaseを更新(heartbeat)——1ページ処理する間にlease有効期限が
      // 切れないよう、ページ毎に延長する。
      const stillLeased = await claimOrRenewLease();
      if (!stillLeased) {
        console.warn("[zaico-sync-worker] lost lease mid-run (unexpected) — stopping cleanly, checkpoint already reflects only fully-processed pages.");
        break;
      }

      // 1ページが1,000件になったことへの対応。
      //
      // ZAICOは per_page を無視して常に1,000件返す(実測)。以前は
      // hasMoreの判定が壊れていて1ページ目で終わっていたため表面化して
      // いなかったが、それを直すと1回の呼び出しで1,000件を処理しようと
      // してLambdaの実行時間を超えうる。特に新規登録は画像取り込みを
      // 伴うので1件あたりの時間が長い。
      //
      // ページ内の途中で時間切れになったら、lastPageを進めずに
      // checkpointだけ書いて次回の呼び出しへ譲る。次回は同じページを
      // 取り直し、seenSourceIdsに入っている分を飛ばして続きから進む。
      // seenSourceIdsは元から再開時に読み込まれているので、スキーマを
      // 変えずにページ内再開が成立する。
      let budgetExhausted = false;
      for (const zaicoItem of zaicoItems) {
        if (seenSourceIds.has(String(zaicoItem.id))) continue; // 前回までに処理済み
        if (Date.now() - startTime > TIME_BUDGET_MS) {
          budgetExhausted = true;
          break;
        }
        const result = await syncOneZaicoItem(zaicoItem, "ZAICO同期(AWS Background Job)", prefetched, port, masterCache);
        seenSourceIds.add(result.zaicoId);
        counts.totalProcessed += 1;
        if (result.status === "created") counts.created += 1;
        else if (result.status === "updated") counts.updated += 1;
        else if (result.status === "unchanged") counts.unchanged += 1;
        else counts.failed += 1;
        if (result.imageImported) counts.imageImported += 1;
      }

      pagesThisRun += 1;

      if (budgetExhausted) {
        // ページの途中。lastPageは進めない(同じページを取り直して続ける)。
        const now = new Date().toISOString();
        await writeCheckpoint({
          status: "RUNNING",
          lastPage: nextPage - 1,
          ...counts,
          seenSourceIds: JSON.stringify(Array.from(seenSourceIds)),
          updatedAt: now,
          retryCount: 0,
        });
        console.log(
          `[zaico-sync-worker] time budget reached mid-page ${nextPage} — checkpointed ${counts.totalProcessed} item(s); next invocation resumes within the same page.`,
        );
        break;
      }

      const isDone = !hasMore || zaicoItems.length === 0;
      const now = new Date().toISOString();

      if (isDone) {
        const missingSourceIds = await findMissingZaicoManagedInventory(seenSourceIds);
        await writeCheckpoint({
          status: "COMPLETED",
          lastPage: nextPage,
          ...counts,
          seenSourceIds: JSON.stringify(Array.from(seenSourceIds)),
          missingSourceIds,
          updatedAt: now,
          finishedAt: now,
          retryCount: 0,
        });
        console.log(`[zaico-sync-worker] job COMPLETED after ${pagesThisRun} page(s) this invocation. totalProcessed=${counts.totalProcessed}`);
        break;
      }

      await writeCheckpoint({
        status: "RUNNING",
        lastPage: nextPage,
        ...counts,
        seenSourceIds: JSON.stringify(Array.from(seenSourceIds)),
        updatedAt: now,
        retryCount: 0,
      });
      nextPage += 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    console.error(`[zaico-sync-worker] error at page ${nextPage}:`, err);
    const retryCount = (job.retryCount ?? 0) + 1;
    if (retryCount >= MAX_RETRIES_BEFORE_FAILED) {
      await writeCheckpoint({ status: "FAILED", lastError: message, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), retryCount });
      console.error(`[zaico-sync-worker] retryCount reached ${retryCount} — marking job FAILED (DLQ相当、ADMINが新規runを開始する必要がある).`);
    } else {
      // §14.3: 一時的な障害はcheckpointを進めず(lastPageは更新しない)、
      // 次のスケジュール実行で同じページから再試行する。exponential
      // backoffはスケジュール自体の5分間隔がそのまま担う。
      await writeCheckpoint({ retryCount, lastError: message, updatedAt: new Date().toISOString() });
    }
  } finally {
    await releaseLease();
  }

  return { pagesProcessed: pagesThisRun };
};
