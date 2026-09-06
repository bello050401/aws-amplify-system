"use server";

import { revalidatePath } from "next/cache";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  syncSingleZaicoItem,
  syncLimitedZaicoItems,
  previewZaicoCatalogSize,
  type ZaicoSyncResult,
  type ZaicoCatalogPreview,
} from "@/lib/inventory/zaicoSync";
import {
  startZaicoBackgroundSyncJob,
  advanceZaicoBackgroundSyncJob,
  cancelZaicoBackgroundSyncJob,
  getZaicoBackgroundSyncStatus,
  recordZaicoSyncJobError,
  type ZaicoBackgroundSyncJob,
} from "@/lib/inventory/zaicoBackgroundSync";
import type { ZaicoSyncMode } from "@/lib/inventory/zaicoDelta";

/**
 * The ADMIN-gated Server Action surface for the ZAICO→BELLO sync (spec
 * §19: UI-only ADMIN gating is not enough — this is the server-side
 * enforcement that stops an EDITOR/VIEWER from triggering a sync even by
 * calling the action directly, bypassing any client-side button
 * disabling). Never returns or logs the ZAICO API token — every error
 * surfaced here comes from lib/zaico/client.ts, which is itself
 * constructed to never include the token in a thrown message.
 */
function requireAdminOrThrow(role: Awaited<ReturnType<typeof getInventoryRole>>): void {
  if (role !== "ADMIN") {
    throw new Error("ZAICO同期はADMIN権限のみ実行できます。");
  }
}

/** バックグラウンド同期系Actionの共通の戻り値。`reason` があれば、それが利用者に見せる失敗理由。 */
export interface ZaicoAdvanceActionResult {
  job: ZaicoBackgroundSyncJob | null;
  shouldContinue: boolean;
  reason?: string;
}

/**
 * バックグラウンド同期系Actionの例外を、**ブラウザから読める形**にして返す
 * (2026-09-07 不具合調査)。
 *
 * ── 何が起きていたか ────────────────────────────────────────────
 *
 * Server Action が投げると、本番ビルドのブラウザには
 * 「An error occurred in the Server Components render. …」という
 * 既定文言と digest しか届かない。そして Staging の SSR ログは
 * CloudWatch へ届かない(lib/inventory/zaicoBackgroundSync.ts の
 * recordZaicoSyncJobError のコメント参照)。結果として、
 * 2026-09-06 15:02:53 UTC の `POST /inventory/settings 500` は
 * **アクセスログに500の事実が残っただけで、原因を示す情報がどこにも
 * 残らなかった**。
 *
 * ── なぜ「投げない」形にするのか ────────────────────────────────
 *
 * 例外を握り潰すためではない。逆で、**必ず残すため**:
 *   1. ジョブ行の lastError に書く(次に画面を開いた人が読める)
 *   2. 呼び出し元へ理由付きで返す(その場で読める)
 * どちらも失われたのが今回の不具合なので、両方に出す。
 *
 * status は変えない —— zaico-sync-worker Lambda が PENDING/RUNNING の
 * ジョブを最後まで進める現在の動作を壊さないため(実際、今回の失敗の
 * 3分後にLambdaが同じジョブを完了させている)。
 */
async function withReportedFailure<T>(
  what: string,
  run: () => Promise<T>,
  onFailure: (reason: string) => T,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `${what}に失敗しました: ${detail}`;
    console.error(`[zaicoSync] ${message}`, err);
    await recordZaicoSyncJobError(message);
    return onFailure(message);
  }
}

export async function syncOneZaicoInventoryAction(zaicoId: string): Promise<ZaicoSyncResult> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);

  const trimmed = zaicoId.trim();
  if (!trimmed) throw new Error("ZAICO在庫IDを入力してください。");

  const who = await getCurrentInventoryUserEmail();
  const result = await syncSingleZaicoItem(trimmed, who);

  revalidatePath("/inventory");
  revalidatePath("/inventory/settings");
  return result;
}

/**
 * 少数件テスト同期(AWSテスト環境構築指示 §8/§26: Phase A「5〜10商品」)
 * — lib/inventory/zaicoSync.tsのsyncAllZaicoItemsをlimit付きで呼ぶ薄い
 * ラッパーsyncLimitedZaicoItemsをそのまま公開するServer Action。旧
 * 「全件同期」用Action(syncAllZaicoInventoriesAction、limitなしで
 * syncAllZaicoItemsを呼ぶだけだった)はBELLO統合改修 master指示書
 * (2026-08-29統合改修版) §6.5でUIの「全件同期」ボタンがバックグラウン
 * ド同期(下のstartZaicoBackgroundSyncAction系)へ統一されたことで
 * UI側の呼び出し元がなくなったため削除した — syncAllZaicoItems自体は
 * このsyncLimitedZaicoItems経由で引き続き使われている(limit引数付き)
 * ので、lib/inventory/zaicoSync.ts側は変更していない。
 */
export async function syncLimitedZaicoInventoriesAction(limit: number): Promise<ZaicoSyncResult> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);

  const who = await getCurrentInventoryUserEmail();
  const result = await syncLimitedZaicoItems(limit, who);

  revalidatePath("/inventory");
  revalidatePath("/inventory/settings");
  return result;
}

/**
 * ZAICO側の規模を同期せずに確認するだけのAction(AWSテスト環境構築指示
 * §8: 実行前件数表示)。書き込みを一切行わないため他のActionと違い
 * revalidatePathは呼ばない。ADMIN限定は他の同期系Actionと統一(通常
 * 業務データではないとはいえ、ZAICO接続そのものへのAPI呼び出しなので
 * 同じ権限境界に揃える)。
 */
export async function previewZaicoCatalogSizeAction(): Promise<ZaicoCatalogPreview> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);
  return previewZaicoCatalogSize();
}

/**
 * BELLO統合改修 master指示書 Phase A: ZAICO background full sync.
 *
 * These four actions drive lib/inventory/zaicoBackgroundSync.ts's
 * checkpointed job from the browser (ZaicoSyncPanel.tsx polls `advance`
 * repeatedly while a job is RUNNING). Each individual call does bounded
 * work (one ZAICO page, see zaicoBackgroundSync.ts) — this is what makes
 * "全件同期" possible without the ~3 minute single-request timeout the
 * master instructions identified in the previous single-request
 * (syncAllZaicoItems, no limit) design. UI-facing §6.5統合改修以降、
 * ユーザーが直接トリガーできる「全件同期」経路はこれだけであり、
 * syncAllZaicoItems自体はsyncLimitedZaicoItems(少数件テスト同期)から
 * limit付きで呼ばれる形でのみ残っている。
 */
/**
 * 同期を開始する。
 *
 * ── 既定は差分 ──────────────────────────────────────────────────
 *
 * 引数を省略すると "DELTA"。前回の**成功**時刻以降にZAICO側で作成/更新
 * されたものだけを処理する。通常運用はこちら。
 *
 * "FULL" は管理者が画面で明示的に選び、確認ダイアログを通ったときだけ
 * 渡される。自動の定期実行から全件が走ることは無い。
 *
 * mode は画面から来る値なので、そのまま信用せず**ここで検証する**。
 * ボタンを無効化するだけでは、アクションを直接呼ばれた場合に防げない
 * (このファイル冒頭の ADMIN ゲートと同じ考え方)。
 */
export async function startZaicoBackgroundSyncAction(
  mode: ZaicoSyncMode = "DELTA",
): Promise<{ started: boolean; reason?: string }> {
  return withReportedFailure(
    "同期の開始",
    async () => {
      const role = await getInventoryRole();
      requireAdminOrThrow(role);
      if (mode !== "DELTA" && mode !== "FULL") {
        return { started: false, reason: "同期の種類が不正です。" };
      }
      const who = await getCurrentInventoryUserEmail();
      return startZaicoBackgroundSyncJob(who, mode);
    },
    (reason) => ({ started: false, reason }),
  );
}

export async function advanceZaicoBackgroundSyncAction(): Promise<ZaicoAdvanceActionResult> {
  return withReportedFailure<ZaicoAdvanceActionResult>(
    "同期の実行",
    async () => {
      const role = await getInventoryRole();
      requireAdminOrThrow(role);
      const who = await getCurrentInventoryUserEmail();
      const result = await advanceZaicoBackgroundSyncJob(who);
      if (!result.shouldContinue) {
        // Only revalidate once the run is done/stopped — not after every
        // single-page advance, which would otherwise force a full
        // Inventory list re-fetch every few seconds while a large sync is
        // still in progress.
        revalidatePath("/inventory");
        revalidatePath("/inventory/settings");
      }
      return result;
    },
    (reason) => ({ job: null, shouldContinue: false, reason }),
  );
}

export async function cancelZaicoBackgroundSyncAction(): Promise<{ reason?: string }> {
  return withReportedFailure<{ reason?: string }>(
    "同期の中止",
    async () => {
      const role = await getInventoryRole();
      requireAdminOrThrow(role);
      await cancelZaicoBackgroundSyncJob();
      revalidatePath("/inventory");
      revalidatePath("/inventory/settings");
      return {};
    },
    (reason) => ({ reason }),
  );
}

export async function getZaicoBackgroundSyncStatusAction(): Promise<{ job: ZaicoBackgroundSyncJob | null; reason?: string }> {
  return withReportedFailure<{ job: ZaicoBackgroundSyncJob | null; reason?: string }>(
    "同期状態の取得",
    async () => {
      const role = await getInventoryRole();
      requireAdminOrThrow(role);
      return { job: await getZaicoBackgroundSyncStatus() };
    },
    (reason) => ({ job: null, reason }),
  );
}
