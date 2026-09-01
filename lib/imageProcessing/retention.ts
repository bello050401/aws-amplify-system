/**
 * 採用されなかった加工結果の保持期間。
 *
 * ## なぜ消すのか
 *
 * 1枚の画像に対して加工を試すたびにmaster/web/thumbの3ファイルが増える。
 * 採用しなかったものを残し続けると、S3の容量が使った回数に比例して
 * 増え続ける。採用されたものと、まだ検討中のものだけを残したい。
 *
 * ## 消してよいものの条件(全部を満たすものだけ)
 *
 * 1. `active === false` —— 採用されていない。
 * 2. 完了から14日を過ぎている —— 「あとで見よう」の余地を残す。
 * 3. 完了している(COMPLETED) —— 実行中・失敗のものは対象外。
 *    失敗の記録は原因を追うために残す価値がある。
 * 4. 同じ画像に対する**採用済みの版が別に存在する** —— これが最後の
 *    砦。採用版が1つも無い画像の加工結果を消すと、加工をやり直す以外に
 *    復旧手段が無くなる。
 *
 * 4つ目は「消しすぎない」ためだけの条件で、消す量は減る。
 * それでよい —— 残しすぎは容量の問題だが、消しすぎは復旧できない。
 *
 * ## 純粋関数にしている理由
 *
 * 判定と削除を分ける。判定だけを取り出せれば、実際に消す前に
 * 「何が消えるのか」を人へ見せられるし、境界(ちょうど14日、採用版が
 * 無い場合)を単体で固定できる。
 */

export const RETENTION_DAYS = 14;

export interface RetentionCandidate {
  id: string;
  imageStorageKey: string;
  version: number;
  active: boolean;
  status: string;
  completedAt: string | null;
  processedMasterKey: string | null;
  webKey: string | null;
  thumbnailKey: string | null;
}

export interface RetentionDecision {
  /** 削除してよいと判断した版。 */
  expired: RetentionCandidate[];
  /** 削除対象のS3キー(重複を除いたもの)。 */
  storageKeys: string[];
  /** 保持する理由の内訳(なぜ消さなかったのかを説明できるように)。 */
  keptReasons: Record<string, number>;
}

export function selectExpiredVersions(
  candidates: RetentionCandidate[],
  now: Date = new Date(),
  retentionDays: number = RETENTION_DAYS,
): RetentionDecision {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  // 画像ごとに「採用済みの版があるか」を先に数える。
  const hasActiveByImage = new Set<string>();
  for (const c of candidates) {
    if (c.active) hasActiveByImage.add(c.imageStorageKey);
  }

  const expired: RetentionCandidate[] = [];
  const keptReasons: Record<string, number> = {};
  const keep = (reason: string) => {
    keptReasons[reason] = (keptReasons[reason] ?? 0) + 1;
  };

  for (const c of candidates) {
    if (c.active) {
      keep("採用済み");
      continue;
    }
    if (c.status !== "COMPLETED") {
      keep("完了していない(実行中・失敗)");
      continue;
    }
    if (!c.completedAt) {
      keep("完了日時が不明");
      continue;
    }
    const completed = Date.parse(c.completedAt);
    if (Number.isNaN(completed)) {
      keep("完了日時を解釈できない");
      continue;
    }
    // ちょうど14日は残す。境界は保持する側へ倒す —— 「14日保持」と
    // 言われて14日目に消えるのは、利用者の期待と食い違う。
    if (completed >= cutoff) {
      keep(`${retentionDays}日以内`);
      continue;
    }
    if (!hasActiveByImage.has(c.imageStorageKey)) {
      // この画像には採用版が1つも無い。消すと加工をやり直すしかなくなる。
      keep("この画像に採用済みの版が無い");
      continue;
    }
    expired.push(c);
  }

  const storageKeys = [
    ...new Set(
      expired
        .flatMap((c) => [c.processedMasterKey, c.webKey, c.thumbnailKey])
        .filter((k): k is string => Boolean(k && k.trim())),
    ),
  ];

  return { expired, storageKeys, keptReasons };
}
