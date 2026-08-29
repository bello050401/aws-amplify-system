import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listInventories } from "@/lib/zaico/client";
import { syncOneZaicoItem } from "./zaicoSync";
import { getServerSyncPort, type ZaicoSyncPort } from "./zaicoSyncPorts";

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
 * counts + seenSourceIds) before returning. The settings UI
 * (ZaicoSyncPanel.tsx) calls `advance` repeatedly (client-side polling)
 * while a job is RUNNING, so the whole catalog gets synced across many
 * short, safe requests instead of one long one — and if the browser tab
 * closes mid-run, reopening the settings page and clicking "続きから再開"
 * (which just calls `advance` again) picks up exactly where the
 * checkpoint left off, never restarting from page 1.
 *
 * What this does NOT (yet) provide: fully unattended execution with no
 * browser tab open at all (a true "scheduled job"). That needs a
 * Lambda (or similar) advancing the job on a timer with no user present
 * — see zaicoSyncPorts.ts's file comment and amplify/data/resource.ts's
 * ZaicoSyncJob comment for why that specific piece is not shipped this
 * round (a confirmed Amplify Gen2 platform gap, not a skipped
 * implementation choice).
 *
 * Reuses the exact same `syncOneZaicoItem` (and therefore the exact same
 * mapping/dedup/diff/image-merge rules) as the existing, AWS-verified
 * 1件/5件/全件 synchronous sync paths — this file adds NO second copy of
 * that logic, only the job/checkpoint/lock bookkeeping around it.
 */

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

function parseSeenSourceIds(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

function toPublicJob(row: {
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
    seenSourceIds: [] as string[],
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

    for (const zaicoItem of zaicoItems) {
      const result = await syncOneZaicoItem(zaicoItem, who, undefined, port);
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
          seenSourceIds: Array.from(seenSourceIds),
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
        seenSourceIds: Array.from(seenSourceIds),
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
