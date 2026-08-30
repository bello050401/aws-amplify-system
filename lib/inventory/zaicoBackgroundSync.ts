import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listInventories } from "@/lib/zaico/client";
import { syncOneZaicoItem } from "./zaicoSync";
import { getServerSyncPort, type ZaicoSyncPort, type MasterCache } from "./zaicoSyncPorts";
import type { Schema } from "@/amplify/data/resource";

type ZaicoSyncJobModel = Schema["ZaicoSyncJob"]["type"];

/**
 * BELLO統合改修 master指示書 Phase A: ZAICO background full sync.
 *
 * Replaces the previous single-request `syncAllZaicoItems`'s "Web
 * request内全件同期" problem (a request blocking on the entire ZAICO
 * catalog times out at ~3 minutes per the master instructions' own
 * observation) with a checkpointed, resumable, lock-protected batch
 * design: `startZaicoBackgroundSyncJob` creates one PENDING job row,
 * and `advanceZaicoBackgroundSyncJob` processes exactly ONE bounded
 * ZAICO page (default 50 items — matching lib/zaico/client.ts's own
 * page size) per call, persisting a checkpoint (lastPage + running
 * counts + seenSourceIds) before returning.
 *
 * BELLO統合業務OS 第五ラウンド §4(P0-A)以降: `amplify/functions/
 * zaico-sync-worker/`が5分毎のスケジュールで同じジョブ行を独立に
 * advanceし続けるため、ブラウザタブを開き続ける必要はもう無い
 * ——`startZaicoBackgroundSyncJob`でPENDING行を作った後は、ブラウザを
 * 閉じてもPCを落としてもLambda側が最後まで進める。この関数
 * (`advanceZaicoBackgroundSyncJob`)自体は「今すぐ手元で少し進めて
 * 結果を見たい」という補助的なADMIN操作として引き続き有効
 * (ZaicoSyncPanel.tsxの「今すぐ1ページ進める」ボタン用)——Lambda側
 * と同じlease機構(claimOrRenewLease/releaseLease、下記)を使うことで、
 * 両者が同じページを二重処理することを防ぐ。
 *
 * Reuses the exact same `syncOneZaicoItem` (and therefore the exact same
 * mapping/dedup/diff/image-merge rules) as the existing, AWS-verified
 * 1件/5件/全件 synchronous sync paths — this file adds NO second copy of
 * that logic, only the job/checkpoint/lock bookkeeping around it.
 */

const LEASE_DURATION_MS = 60_000; // ブラウザ側は1ページ分だけの短時間占有 — Lambda側(4分)よりずっと短くしてよい(1回のadvance呼び出しは通常数秒で終わる)
const BROWSER_OWNER_PREFIX = "browser";

/**
 * amplify/functions/zaico-sync-worker/handler.tsのclaimOrRenewLeaseと
 * 同じ意図(「誰も保持していない、または期限切れ、または自分自身」の
 * 時だけ成功する)だが、Amplify Data(AppSync経由の`.update()`)は生
 * DynamoDBのConditionExpressionを露出しないため、ここは
 * read→判定→writeの非原子的な実装に留まる——read/writeの間に別の
 * 実行主体が割り込む理論上のrace windowがある。
 *
 * これを許容できる理由: (1) 実際の衝突頻度は極めて低い(Lambda側は
 * 5分に1回、ブラウザ側はADMINの手動操作という非同期な頻度差)。
 * (2) 万一衝突して同じページが二重処理されても、syncOneZaicoItemの
 * 冪等性(verify:zaicoの「re-syncing the identical item is a no-op」
 * テストで検証済み)により、実害は「同じ商品をもう一度unchanged判定
 * するだけの無駄なAPI呼び出し」に留まり、重複作成やデータ破損には
 * ならない。真の原子性が必要になった場合は、この関数だけをLambda側
 * と同じ生DynamoDB実装へ差し替えれば良い(port抽象を壊さない)。
 */
async function claimLease(ownerId: string): Promise<boolean> {
  const { data: current } = await serverDataClient.models.ZaicoSyncJob.get({ id: ZAICO_SYNC_JOB_SINGLETON_ID }, inventoryAuthMode);
  if (current?.leaseOwner && current.leaseOwner !== ownerId) {
    const stillValid = current.leaseExpiresAt && new Date(current.leaseExpiresAt).getTime() > Date.now();
    if (stillValid) return false; // 他の実行主体(Lambda、または別ブラウザタブ)が有効なleaseを保持中
  }
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  const now = new Date().toISOString();
  try {
    await serverDataClient.models.ZaicoSyncJob.update({ id: ZAICO_SYNC_JOB_SINGLETON_ID, leaseOwner: ownerId, leaseExpiresAt, lastHeartbeatAt: now }, inventoryAuthMode);
    return true;
  } catch {
    return false;
  }
}

async function releaseLeaseIfOwned(ownerId: string): Promise<void> {
  try {
    const { data: fresh } = await serverDataClient.models.ZaicoSyncJob.get({ id: ZAICO_SYNC_JOB_SINGLETON_ID }, inventoryAuthMode);
    if (fresh?.leaseOwner === ownerId) {
      await serverDataClient.models.ZaicoSyncJob.update({ id: ZAICO_SYNC_JOB_SINGLETON_ID, leaseOwner: null, leaseExpiresAt: null }, inventoryAuthMode);
    }
  } catch (err) {
    console.error("[advanceZaicoBackgroundSyncJob] failed to release lease (non-fatal):", err);
  }
}

/** The one well-known row id — see file comment above for why a singleton row is this job's lock/lease mechanism. */
const ZAICO_SYNC_JOB_SINGLETON_ID = "zaico-full-sync-singleton";

/** How many ZAICO items one `advance` call processes at most — matches lib/zaico/client.ts's own per-page size, so one advance call is "fetch and sync one ZAICO page". */
const ITEMS_PER_ADVANCE = 50;

export type ZaicoSyncJobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface ZaicoBackgroundSyncJob {
  status: ZaicoSyncJobStatus;
  lastPage: number;
  totalProcessed: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  imageImported: number;
  missingSourceIds: string[];
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  triggeredBy: string | null;
}

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §6.4根本修正:
 * `ZaicoSyncJob.seenSourceIds`は`a.json()`(AWSJSON)フィールド —
 * lib/inventory/customFieldsCodec.tsで既に文書化されている「wire
 * quirk」(ミューテーション変数には実際のJSON文字列を渡す必要があり、
 * 生のJS配列/オブジェクトを渡すと`Variable '...' has an invalid
 * value.`で失敗する)が、このファイルには適用されていなかった —
 * これが実際に報告された`Variable 'seenSourceIds' has an invalid
 * value.`エラーの根本原因(startZaicoBackgroundSyncJob/
 * advanceZaicoBackgroundSyncJobの3箇所すべてで生配列を直接渡していた)。
 * `stringifySeenSourceIds`で書き込み前に必ず文字列化し、この
 * `parseSeenSourceIds`は文字列(常にこちらが書き込む形)・配列(一部の
 * 読み取り経路で観測される、既にパース済みの形)・その他(壊れた値/
 * 未設定)のいずれが来ても安全に空集合へ倒す。
 */
export function parseSeenSourceIds(raw: unknown): Set<string> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parseSeenSourceIds(parsed);
    } catch (err) {
      console.error("[ZaicoSyncJob.seenSourceIds] failed to JSON.parse stored value:", raw, err);
      return new Set();
    }
  }
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

/** The write-side half of the fix above — always call this, never pass `Array.from(...)`/`[]` directly to a ZaicoSyncJob.seenSourceIds field. */
function stringifySeenSourceIds(ids: Iterable<string>): string {
  return JSON.stringify(Array.from(ids));
}

/** Exported for the same reason as parseSeenSourceIds above. */
export function toPublicJob(row: {
  status: ZaicoSyncJobStatus;
  lastPage?: number | null;
  totalProcessed?: number | null;
  created?: number | null;
  updated?: number | null;
  unchanged?: number | null;
  failed?: number | null;
  imageImported?: number | null;
  missingSourceIds?: (string | null)[] | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  triggeredBy?: string | null;
}): ZaicoBackgroundSyncJob {
  return {
    status: row.status,
    lastPage: row.lastPage ?? 0,
    totalProcessed: row.totalProcessed ?? 0,
    created: row.created ?? 0,
    updated: row.updated ?? 0,
    unchanged: row.unchanged ?? 0,
    failed: row.failed ?? 0,
    imageImported: row.imageImported ?? 0,
    missingSourceIds: (row.missingSourceIds ?? []).filter((v): v is string => Boolean(v)),
    startedAt: row.startedAt ?? null,
    updatedAt: row.updatedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    lastError: row.lastError ?? null,
    triggeredBy: row.triggeredBy ?? null,
  };
}

/** Read-only — used by the settings UI to render current progress, and by start/advance to decide what to do next. */
export async function getZaicoBackgroundSyncStatus(): Promise<ZaicoBackgroundSyncJob | null> {
  const { data } = await serverDataClient.models.ZaicoSyncJob.get({ id: ZAICO_SYNC_JOB_SINGLETON_ID }, inventoryAuthMode);
  if (!data) return null;
  return toPublicJob(data);
}

/**
 * Starts a new background sync run. Refuses (lock/lease) if one is
 * already PENDING/RUNNING — the caller (Server Action) surfaces this as
 * "already running", never silently queues a second one. Resets every
 * counter/checkpoint field back to zero/empty, since this is a brand new
 * full-catalog pass.
 */
export async function startZaicoBackgroundSyncJob(who: string | null): Promise<{ started: boolean; reason?: string }> {
  const existing = await getZaicoBackgroundSyncStatus();
  if (existing && (existing.status === "PENDING" || existing.status === "RUNNING")) {
    return { started: false, reason: "既にバックグラウンド同期が実行中です。" };
  }

  const now = new Date().toISOString();
  const fields = {
    status: "PENDING" as const,
    lastPage: 0,
    totalProcessed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    imageImported: 0,
    seenSourceIds: stringifySeenSourceIds([]),
    missingSourceIds: [] as string[],
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    lastError: null,
    triggeredBy: who,
  };

  const { errors } = existing
    ? await serverDataClient.models.ZaicoSyncJob.update({ id: ZAICO_SYNC_JOB_SINGLETON_ID, ...fields }, inventoryAuthMode)
    : await serverDataClient.models.ZaicoSyncJob.create({ id: ZAICO_SYNC_JOB_SINGLETON_ID, ...fields }, inventoryAuthMode);
  if (errors) {
    return { started: false, reason: `開始に失敗しました: ${JSON.stringify(errors)}` };
  }
  return { started: true };
}

/** ADMIN-triggered stop. Checked at the top of every `advance` call and between items within a batch, so an in-progress run stops promptly, not just before its next scheduled start. */
export async function cancelZaicoBackgroundSyncJob(): Promise<void> {
  const existing = await getZaicoBackgroundSyncStatus();
  if (!existing || (existing.status !== "PENDING" && existing.status !== "RUNNING")) return;
  await serverDataClient.models.ZaicoSyncJob.update(
    { id: ZAICO_SYNC_JOB_SINGLETON_ID, status: "CANCELLED", finishedAt: new Date().toISOString() },
    inventoryAuthMode,
  );
}

export interface AdvanceResult {
  job: ZaicoBackgroundSyncJob;
  /** true while the caller should keep calling advance (job is still RUNNING and not yet COMPLETED/CANCELLED/FAILED). */
  shouldContinue: boolean;
}

/**
 * Processes exactly one ZAICO page (up to ITEMS_PER_ADVANCE items),
 * persists an updated checkpoint, and returns. Idempotent to call
 * repeatedly — if the job isn't PENDING/RUNNING (nothing to do, or
 * someone cancelled it), returns immediately without touching ZAICO or
 * BELLO at all.
 *
 * `who`/`port` default exactly like the synchronous sync paths — `port`
 * exists so a future test (or, eventually, a real background-execution
 * adapter) can substitute a different implementation without touching
 * this function's logic.
 */
export async function advanceZaicoBackgroundSyncJob(who: string | null, port: ZaicoSyncPort = getServerSyncPort()): Promise<AdvanceResult> {
  const { data: row } = await serverDataClient.models.ZaicoSyncJob.get({ id: ZAICO_SYNC_JOB_SINGLETON_ID }, inventoryAuthMode);
  if (!row || (row.status !== "PENDING" && row.status !== "RUNNING")) {
    return { job: row ? toPublicJob(row) : toPublicJob({ status: "COMPLETED" }), shouldContinue: false };
  }

  // 第五ラウンド §4(P0-A): zaico-sync-worker Lambdaが今まさに同じ
  // ジョブを処理中かもしれない——lease確保できなければ何もせず
  // 「今は進められない、後で再試行してください」を返す(shouldContinue
  // はtrueのまま——UIは少し待って再度advanceを呼べば良い)。
  const ownerId = `${BROWSER_OWNER_PREFIX}:${who ?? "anonymous"}:${Date.now()}`;
  const leaseAcquired = await claimLease(ownerId);
  if (!leaseAcquired) {
    return { job: toPublicJob(row), shouldContinue: true };
  }
  try {
    return await advanceOnePage(row, who, port);
  } finally {
    await releaseLeaseIfOwned(ownerId);
  }
}

async function advanceOnePage(row: ZaicoSyncJobModel, who: string | null, port: ZaicoSyncPort): Promise<AdvanceResult> {

  const nextPage = (row.lastPage ?? 0) + 1;
  const seenSourceIds = parseSeenSourceIds(row.seenSourceIds);

  const counts = {
    totalProcessed: row.totalProcessed ?? 0,
    created: row.created ?? 0,
    updated: row.updated ?? 0,
    unchanged: row.unchanged ?? 0,
    failed: row.failed ?? 0,
    imageImported: row.imageImported ?? 0,
  };

  try {
    const { items: zaicoItems, hasMore } = await listInventories(nextPage, ITEMS_PER_ADVANCE);

    // Re-check cancellation right before writing — a cancel requested
    // while this batch's ZAICO fetch/sync was in flight still takes
    // effect at the very next checkpoint, not after a further page.
    const { data: freshRow } = await serverDataClient.models.ZaicoSyncJob.get({ id: ZAICO_SYNC_JOB_SINGLETON_ID }, inventoryAuthMode);
    if (!freshRow || freshRow.status === "CANCELLED") {
      return { job: freshRow ? toPublicJob(freshRow) : toPublicJob({ status: "CANCELLED" }), shouldContinue: false };
    }

    // BELLO ZAICO級高速化仕様書 §30.7(baseline計測で確定した根本原因の
    // 修正): この関数はsyncOneZaicoItemへ`prefetched`を渡していなかった
    // ため、このページの全50件が(unchangedであっても)findExistingBySourceId
    // 経由でInventoryテーブル全件Scanを1件ずつ繰り返していた——
    // syncAllZaicoItems(旧同期経路)は最初からfetchAllZaicoManaged()を
    // 1回prefetchしていたのに、後発のこの関数だけ祖無かった、という
    // 実在した性能regression。1ページにつき1回のprefetchで、このページ
    // 内の全アイテムがO(1)のMapルックアップになる(scripts/
    // benchmark-zaico-sync.tsのbefore/after計測で実証)。masterCacheも
    // 同じ理由で1ページ1個、空で開始する。
    const prefetched = await port.fetchAllZaicoManaged();
    const masterCache: MasterCache = { categories: new Map(), locations: new Map() };

    for (const zaicoItem of zaicoItems) {
      const result = await syncOneZaicoItem(zaicoItem, who, prefetched, port, masterCache);
      seenSourceIds.add(result.zaicoId);
      counts.totalProcessed += 1;
      if (result.status === "created") counts.created += 1;
      else if (result.status === "updated") counts.updated += 1;
      else if (result.status === "unchanged") counts.unchanged += 1;
      else counts.failed += 1;
      if (result.imageImported) counts.imageImported += 1;
    }

    const isDone = !hasMore || zaicoItems.length === 0;
    const now = new Date().toISOString();

    if (isDone) {
      // Missing-detection sweep (master指示書 Phase A: 「deletion/missing
      // safety」) — only ever computed on a genuinely COMPLETED full pass,
      // never on a partial/cancelled one, so an interrupted sync can never
      // misreport a real, still-existing ZAICO item as missing. Reporting
      // only — nothing here is ever deleted.
      const missingSourceIds = await findMissingZaicoManagedInventory(seenSourceIds);
      const { data: updated, errors } = await serverDataClient.models.ZaicoSyncJob.update(
        {
          id: ZAICO_SYNC_JOB_SINGLETON_ID,
          status: "COMPLETED",
          lastPage: nextPage,
          ...counts,
          seenSourceIds: stringifySeenSourceIds(seenSourceIds),
          missingSourceIds,
          updatedAt: now,
          finishedAt: now,
        },
        inventoryAuthMode,
      );
      if (errors || !updated) throw new Error(`チェックポイントの保存に失敗しました: ${JSON.stringify(errors)}`);
      return { job: toPublicJob(updated), shouldContinue: false };
    }

    const { data: updated, errors } = await serverDataClient.models.ZaicoSyncJob.update(
      {
        id: ZAICO_SYNC_JOB_SINGLETON_ID,
        status: "RUNNING",
        lastPage: nextPage,
        ...counts,
        seenSourceIds: stringifySeenSourceIds(seenSourceIds),
        updatedAt: now,
      },
      inventoryAuthMode,
    );
    if (errors || !updated) throw new Error(`チェックポイントの保存に失敗しました: ${JSON.stringify(errors)}`);
    return { job: toPublicJob(updated), shouldContinue: true };
  } catch (err) {
    // A failure fetching/processing this page (e.g. ZAICO API down) marks
    // the job FAILED rather than silently stalling forever at the same
    // checkpoint — the ADMIN can see the error and start a new run
    // (which re-syncs from page 1; already-synced items are unaffected
    // since syncOneZaicoItem's own dedup makes re-processing them a safe
    // "unchanged" no-op, not a duplicate).
    const message = err instanceof Error ? err.message : "不明なエラー";
    const { data: failedRow } = await serverDataClient.models.ZaicoSyncJob.update(
      { id: ZAICO_SYNC_JOB_SINGLETON_ID, status: "FAILED", lastError: message, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
      inventoryAuthMode,
    );
    return { job: failedRow ? toPublicJob(failedRow) : toPublicJob({ status: "FAILED", lastError: message }), shouldContinue: false };
  }
}

/**
 * Every current ZAICO-managed BELLO record whose sourceInventoryId was
 * NOT seen in this (just-completed) run. Read-only — the caller only
 * ever stores this list for admin visibility, never acts on it
 * automatically (master指示書 Phase A: 「勝手にZAICOの商品を更新・削除
 * しない」/ deletion-safety).
 */
async function findMissingZaicoManagedInventory(seenSourceIds: Set<string>): Promise<string[]> {
  const missing: string[] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt } = await serverDataClient.models.Inventory.list({
      filter: { sourceSystem: { eq: "ZAICO" } },
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    for (const item of data) {
      if (item.deletedAt || !item.sourceInventoryId) continue;
      if (!seenSourceIds.has(item.sourceInventoryId)) missing.push(item.sourceInventoryId);
    }
    nextToken = nt;
  } while (nextToken);
  return missing;
}
