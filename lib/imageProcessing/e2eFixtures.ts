import "server-only";
import type { Schema } from "@/amplify/data/resource";

/**
 * 画像状態取得の実React境界と最終統合(2026-09-13) — ImageProcessingPanel.tsx
 * 自身の読取(バージョン一覧・pending job状態)を、実際のNext.jsアプリ
 * (本物のpage.tsx/ImageProcessingPanel.tsx)を本物のブラウザで動かして
 * 確認するためのE2Eフィクスチャ。lib/inventory/e2eFixtures.tsと同じ
 * 二重ゲート(isE2EFixtureModeActive() — NODE_ENV!=="production" かつ
 * INVENTORY_E2E_FIXTURES==="1")の内側でしか呼ばれない
 * (jobService.tsの各呼び出し箇所を参照、呼び出し前に必ずゲートを通す)。
 *
 * 【なぜ専用の接頭辞が要るか】ギャラリー側のe2e-fixture:接頭辞
 * (lib/inventory/e2eFixtures.ts、ImageProcessingPanel.tsxの
 * isE2EFixtureStorageKey)は、このパネル自体の対象からその画像を
 * **除外する**ためのものだった(実体の無い合成画像にジョブ状態を問い
 * 合わせて壊れるのを防ぐため)。ここはその逆で、パネル自身の読取ロジック
 * を実際に動かして検証したいので、e2e-fixture:とは別の接頭辞
 * "e2e-imgproc:"を使い、isE2EFixtureStorageKeyのフィルタに引っかからない
 * ようにする。
 *
 * 書き込み系(enqueueProcessingJob等)には一切のフィクスチャ分岐を
 * 追加していない——ここは読み取り専用の表示検証のみを目的とする
 * (lib/inventory/e2eFixtures.tsと同じ方針)。「再加工する」等のボタンを
 * このE2Eモードで押すと、実際のAppSyncスタブへ到達を試みて失敗する
 * (=書込系は一切偽装しない)。
 */
const PREFIX = "e2e-imgproc:";

export function isImageProcessingE2EKey(storageKey: string): boolean {
  return storageKey.startsWith(PREFIX);
}

type VersionRow = Schema["ImageProcessingVersion"]["type"];

function makeVersionRow(overrides: Partial<VersionRow> & { id: string; version: number; status: string; imageStorageKey: string }): VersionRow {
  return {
    active: false,
    aspectRatio: null,
    processedMasterKey: null,
    webKey: null,
    thumbnailKey: null,
    failureCode: null,
    failureDetail: null,
    completedAt: null,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  } as unknown as VersionRow;
}

// "e2e-imgproc:race"の呼び出し回数(プロセス内で保持——このプロセスの
// 寿命=1回のdevサーバー起動ぶんの手動QAセッションを想定)。
const raceCallCounts = new Map<string, number>();

/**
 * jobService.listVersions()のE2E版。storageKeyごとに固定シナリオ:
 *  - "e2e-imgproc:ready-*"       … 常にREADY+active(通常の正常系、
 *                                    他の画像が失敗している間も表示が
 *                                    継続することの対照)。
 *  - "e2e-imgproc:partial-fail"  … 常に例外(listVersionsForKeysの
 *                                    allSettredがこの画像だけ`null`に
 *                                    する——他画像を巻き込まない部分
 *                                    失敗、回復しない固定シナリオ)。
 *  - "e2e-imgproc:race"          … 1回目は例外(初回失敗)、2回目以降は
 *                                    呼ばれた回数をそのままversion/
 *                                    statusへ反映する(奇数=READY、
 *                                    偶数=NEEDS_REVIEW)。「再試行」を
 *                                    連打したときにどちらの応答が画面に
 *                                    残るかを、ラベルの文字列だけで
 *                                    判定できるようにするため。
 */
export async function e2eListVersions(imageStorageKey: string): Promise<VersionRow[]> {
  if (imageStorageKey === `${PREFIX}partial-fail`) {
    throw new Error("[e2e-imgproc] simulated per-image version fetch failure (does not recover)");
  }
  if (imageStorageKey === `${PREFIX}race`) {
    const count = (raceCallCounts.get(imageStorageKey) ?? 0) + 1;
    raceCallCounts.set(imageStorageKey, count);
    if (count === 1) {
      throw new Error("[e2e-imgproc] simulated transient version fetch failure (recovers on retry)");
    }
    const status = count % 2 === 0 ? "NEEDS_REVIEW" : "READY";
    return [makeVersionRow({ id: `race-v${count}`, version: count, status, active: status === "READY", imageStorageKey })];
  }
  if (imageStorageKey.startsWith(`${PREFIX}ready-`)) {
    return [makeVersionRow({ id: `${imageStorageKey}-v1`, version: 1, status: "READY", active: true, webKey: `${imageStorageKey}-web`, imageStorageKey })];
  }
  // 未知のe2e-imgprocキー(whole-fail-once等、Action層で全体拒否される
  // 分)はここへは実際には到達しない想定——フォールバックとして安全側
  // (未加工扱い)にしておく。
  return [];
}

/** jobService.listPendingJobStatuses()のE2E版。"e2e-imgproc:busy-processing"だけPROCESSING扱いにする(15秒ポーリングを起動させるため)。 */
export async function e2eListPendingJobStatuses(imageStorageKeys: string[]): Promise<Record<string, "PENDING" | "PROCESSING">> {
  const result: Record<string, "PENDING" | "PROCESSING"> = {};
  for (const key of imageStorageKeys) {
    if (key === `${PREFIX}busy-processing`) result[key] = "PROCESSING";
  }
  return result;
}
