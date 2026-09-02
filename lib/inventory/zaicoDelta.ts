import type { ZaicoInventory } from "@/lib/zaico/client";

/**
 * 差分同期の判定。純粋関数だけ。DBにもZAICOにも触らない。
 *
 * ── ZAICO API はサーバー側の差分取得に対応していない ────────────
 *
 * 2026-09-02 に実際に叩いて確認した（`scripts/probe-zaico-delta-support.ts`）。
 *
 *   updated_at_since / updated_since / since / updated_at_gteq /
 *   updated_at_from / from / modified_since / q[updated_at_gteq]
 *
 * の8種類を、過去日時と**未来日時**の両方で試した。応答は常に
 * 「200 / 1,000件 / 先頭id 44665891」で、基準（パラメータなし）と
 * 1つも変わらなかった。未知のクエリを黙って無視する実装。
 *
 * つまり **取得の往復は減らせない**。5,313件を取るには今までどおり
 * 全ページを辿る必要がある。
 *
 * ── では何が速くなるのか ────────────────────────────────────────
 *
 * 減らせるのは1件ごとの処理のほう。1件につき
 *
 *   既存在庫の照合 → マージ判定 → Inventory.update →
 *   画像の取り込み → 履歴の記録
 *
 * が走る。同期時間の大半はここで、取得そのものではない。前回以降
 * 変わっていない在庫をここへ通さなければ、その分がまるごと消える。
 *
 * `updated_at` は実データの1,000件すべてに入っていることを確認済み
 * （同じ実測より。例: `2026-04-22T14:49:07+09:00`）。
 */

/** 時刻の境界で取りこぼさないための巻き戻し幅。 */
export const DELTA_OVERLAP_MS = 5 * 60 * 1000;

/**
 * 次回の差分同期が「いつ以降」を見るかを決める。
 *
 * 前回の成功時刻から少し**巻き戻す**。ZAICO側の更新時刻とBELLO側の
 * 実行時刻には、時計のずれ・書き込みの遅延・実行中の更新といったずれが
 * あり、ちょうどの時刻で切ると境界のものを落とす。
 *
 * 重複して取るのは安全（同じ在庫をもう一度処理しても結果は同じ）。
 * 落とすほうは気づけない。
 */
export function resolveDeltaSince(lastSuccessfulSyncAt: string | null | undefined): string | null {
  if (!lastSuccessfulSyncAt) return null; // 初回。全件を見るしかない
  const t = new Date(lastSuccessfulSyncAt).getTime();
  // 壊れた値で「1970年以降」にすると全件処理になる。それは遅いだけで
  // 間違ってはいないので、安全側としてそのまま全件へ倒す。
  if (!Number.isFinite(t)) return null;
  return new Date(t - DELTA_OVERLAP_MS).toISOString();
}

/**
 * この在庫を今回処理する必要があるか。
 *
 * `since` が null（初回・全件同期）なら常に true。
 *
 * **`updated_at` が読めないものは必ず処理する。** 判断できないものを
 * 飛ばすと、変更が永久に反映されないまま誰も気づけない。判断できない
 * ときは「やる」側へ倒す。
 */
export function needsSync(item: Pick<ZaicoInventory, "updated_at" | "created_at">, since: string | null): boolean {
  if (!since) return true;
  const cutoff = new Date(since).getTime();
  if (!Number.isFinite(cutoff)) return true;

  // 更新日時。無ければ作成日時で代用する（新規作成直後は updated_at が
  // 無いことがある）。
  const stamp = item.updated_at ?? item.created_at ?? null;
  if (!stamp) return true;
  const t = new Date(stamp).getTime();
  if (!Number.isFinite(t)) return true;

  return t >= cutoff;
}

export interface DeltaSplit<T> {
  /** 実際に同期処理へ渡すもの。 */
  toProcess: T[];
  /** 前回以降変わっていないので処理を省くもの。観測済みとしては記録する。 */
  skipped: T[];
}

/**
 * 1ページぶんを「処理する / 省く」へ分ける。
 *
 * 省いたものも**観測済みとして記録する**必要がある。記録しないと、
 * 完了時の「ZAICOに無くなった在庫の検出」が、単に今回処理しなかった
 * だけの在庫を「消えた」と誤報告する。
 */
export function splitByDelta<T extends Pick<ZaicoInventory, "updated_at" | "created_at">>(
  items: T[],
  since: string | null,
): DeltaSplit<T> {
  if (!since) return { toProcess: items, skipped: [] };
  const toProcess: T[] = [];
  const skipped: T[] = [];
  for (const item of items) {
    if (needsSync(item, since)) toProcess.push(item);
    else skipped.push(item);
  }
  return { toProcess, skipped };
}

export type ZaicoSyncMode = "DELTA" | "FULL";

/**
 * 同期完了時に、次回の基準として記録する時刻。
 *
 * **完了時刻ではなく開始時刻を記録する。** 実行中（5,313件だと数分〜)に
 * ZAICO側で更新されたものは、そのページを既に通り過ぎていれば今回は
 * 拾えていない。完了時刻を記録すると、それが次回の対象から外れて
 * 永久に落ちる。開始時刻なら次回が拾い直す。
 *
 * 重複して拾うのは安全。落とすのは気づけない。
 */
export function nextSuccessfulSyncAt(startedAt: string | null | undefined, fallbackNowIso: string): string {
  if (!startedAt) return fallbackNowIso;
  const t = new Date(startedAt).getTime();
  if (!Number.isFinite(t)) return fallbackNowIso;
  return new Date(t).toISOString();
}

/** 同期結果の要約。ログと画面表示で同じものを使う。 */
export interface SyncRunSummary {
  mode: ZaicoSyncMode;
  since: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  skippedByDelta: number;
  failed: number;
  lastSuccessfulSyncAt: string | null;
}

/** 経過ミリ秒。どちらかが欠けていれば null（0と混同しない）。 */
export function elapsedMs(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const a = new Date(startedAt).getTime();
  const b = new Date(finishedAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

/** 人が読む1行。ログにも画面にも同じ文言を出す。 */
export function describeRun(s: SyncRunSummary): string {
  const ms = elapsedMs(s.startedAt, s.finishedAt);
  const time = ms === null ? "計測不可" : `${(ms / 1000).toFixed(1)}秒`;
  const label = s.mode === "DELTA" ? "差分同期" : "全件同期";
  const since = s.mode === "DELTA" ? (s.since ? `（${s.since} 以降）` : "（初回のため全件）") : "";
  return (
    `${label}${since}: ` +
    `取得${s.fetched}件 / 新規${s.created} 更新${s.updated} 変更なし${s.unchanged} ` +
    `差分スキップ${s.skippedByDelta} 失敗${s.failed} / ${time}`
  );
}
