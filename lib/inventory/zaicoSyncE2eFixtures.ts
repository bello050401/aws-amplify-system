import "server-only";
import { cookies } from "next/headers";
import { isE2EFixtureModeActive } from "./e2eFixtures";
import type { ZaicoBackgroundSyncJob } from "./zaicoBackgroundSync";

/**
 * ZAICO候補3b3b8cd(持ち越し再試行/復旧スキャンの基準固着修正)を、
 * 実ブラウザ・実ZaicoSyncPanel.tsxで安全に確認するためのQA専用
 * フィクスチャ。
 *
 * ── なぜ実ジョブ行を使えないか ─────────────────────────────────────
 *
 * ZaicoSyncPanel.tsxはマウント時に`getZaicoBackgroundSyncStatusAction`を
 * 呼び、返ってきたジョブが PENDING/RUNNING ならその場で
 * `scheduleAdvance(0)`——`advanceZaicoBackgroundSyncAction`経由の実ZAICO
 * API呼び出しへ即座に進む設計になっている。実DynamoDB行を使う限り、
 * 「実ブラウザで開いただけで実際の同期が進んでしまう」経路を避ける
 * 安全な方法が無い。
 *
 * ここで返す合成ジョブは常に`status: "COMPLETED"`——ZaicoSyncPanel.tsxの
 * useEffectはstatusがPENDING/RUNNINGのときしかscheduleAdvanceを呼ばない
 * ため、この一点だけで「マウントしただけで同期が進む」経路が構造的に
 * 閉じる(この安全設計はこのファイル単体では閉じない——`start`/`advance`/
 * `cancel`側の対の対策は`lib/inventory/zaicoBackgroundSync.ts`の各関数
 * 冒頭ガード参照)。
 *
 * ── 二重ゲート ──────────────────────────────────────────────────
 *
 * 新しいフラグを追加しない。`lib/inventory/e2eFixtures.ts`の
 * `isE2EFixtureModeActive()`(NODE_ENV!=="production" かつ
 * INVENTORY_E2E_FIXTURES==="1")をそのまま再利用する——本番でこの
 * ファイルの分岐が通る経路は無い(呼び出し元の`zaicoBackgroundSync.ts`
 * が毎回このゲートを先に確認してから初めてこのモジュールの関数を呼ぶ)。
 *
 * ── シナリオ切替(Cookie) ────────────────────────────────────────
 *
 * `ZaicoSyncJob`はsingleton行なので、1つのdevサーバーで同時に複数の
 * 状態を返し分けるにはリクエスト単位の入力が要る。
 * `lib/amplify/requireInventoryUser.ts`の`__inv_e2e_role`と同じ発想で、
 * 読み取り専用のCookie(`__inv_e2e_zaico_scenario`)をPlaywright側が
 * 事前に積んでおくことで、同じ1プロセスのまま「通常の差分」「復旧
 * スキャン」を行き来する。このCookie自体はゲートではない——
 * isE2EFixtureModeActive()がfalseならこのファイルの関数は
 * そもそも呼ばれない。
 */
export type ZaicoSyncE2EScenario = "delta" | "recovery";

const SCENARIO_COOKIE = "__inv_e2e_zaico_scenario";

function resolveScenario(): ZaicoSyncE2EScenario {
  const raw = cookies().get(SCENARIO_COOKIE)?.value;
  return raw === "recovery" ? "recovery" : "delta";
}

/**
 * 差分同期の通常回。基準時刻(`syncSince`)がある通常のDELTA完了に加え、
 * 「1件だけ恒久的に失敗し続けている」持ち越し再試行(task_23b5395c49434d58b8
 * / task_ff42042dfee35233e9)を1件だけ乗せてある——0件だと
 * ZaicoSyncPanel.tsxの「持ち越し再試行」行自体が描画されない
 * (`bgJob.pendingRetryCount > 0`)ため。
 */
const DELTA_SCENARIO: ZaicoBackgroundSyncJob = {
  status: "COMPLETED",
  lastPage: 12,
  totalProcessed: 48,
  created: 2,
  updated: 45,
  unchanged: 0,
  failed: 1,
  imageImported: 3,
  missingSourceIds: [],
  startedAt: "2026-09-14T21:00:03.000Z",
  updatedAt: "2026-09-14T21:00:41.000Z",
  finishedAt: "2026-09-14T21:00:41.000Z",
  lastError: null,
  triggeredBy: null, // 5分毎の定期実行(Lambda)相当——ADMIN手動実行ではない
  mode: "DELTA",
  syncSince: "2026-09-14T16:00:00.000Z",
  skippedByDelta: 5_265,
  lastSuccessfulSyncAt: "2026-09-14T21:00:03.000Z",
  pendingRetryCount: 1,
};

/**
 * 復旧スキャン回。`failedSourceIds`が(移行前ジョブ等の理由で)信頼できず
 * `needsRecoveryScan`が立った結果、`syncSince`がnullになり全件を
 * 再捕捉した回——`startZaicoBackgroundSyncJob`のコメント参照。
 *
 * `lastSuccessfulSyncAt`はわざと**過去の実在時刻**にしてある(nullに
 * しない)——「一度も成功したことがない初回」ではなく「過去に成功した
 * ことはあるが、今回は基準を無視して復旧のため全件を回した」ことを
 * 区別して確認できるようにするため(テスト項目「初回と毎回表示を
 * 混同しない」)。ZaicoSyncPanel.tsx側の文言(「初回または復旧時」)は
 * 両ケースで同じだが、詳細の「最終同期成功」欄に過去日時が出るか
 * (=復旧)、「まだ一度も完了していません」と出るか(=真の初回)で
 * QAが見分けられる。
 */
const RECOVERY_SCENARIO: ZaicoBackgroundSyncJob = {
  status: "COMPLETED",
  lastPage: 107,
  totalProcessed: 5_313,
  created: 0,
  updated: 5_313,
  unchanged: 0,
  failed: 0,
  imageImported: 1,
  missingSourceIds: [],
  startedAt: "2026-09-14T03:00:00.000Z",
  updatedAt: "2026-09-14T03:14:22.000Z",
  finishedAt: "2026-09-14T03:14:22.000Z",
  lastError: null,
  triggeredBy: null,
  mode: "DELTA",
  syncSince: null, // ← 復旧スキャン: 基準時刻を無視して全件を再捕捉した
  skippedByDelta: 0, // since===nullなのでdelta skip自体が発生しない
  lastSuccessfulSyncAt: "2026-09-13T21:00:03.000Z", // 過去に成功歴あり(=真の初回ではない)
  pendingRetryCount: 0, // 全件再捕捉により今回で恒久失敗リストが解消
};

const SCENARIOS: Record<ZaicoSyncE2EScenario, ZaicoBackgroundSyncJob> = {
  delta: DELTA_SCENARIO,
  recovery: RECOVERY_SCENARIO,
};

/** `lib/inventory/zaicoBackgroundSync.ts`の各関数がisE2EFixtureModeActive()通過後にだけ呼ぶ。 */
export function e2eZaicoBackgroundSyncStatus(): ZaicoBackgroundSyncJob {
  return SCENARIOS[resolveScenario()];
}

/** zaicoBackgroundSync.ts側の各ガードが同じ判定を再実装しないための再エクスポート。 */
export { isE2EFixtureModeActive as isZaicoSyncE2EFixtureModeActive };
