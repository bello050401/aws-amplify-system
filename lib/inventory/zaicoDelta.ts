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
 *
 * ── 2026-09-12 追記: 時刻だけでは「BELLO未取込」を判定できない ─────
 *
 * `needsSync`は「ZAICO側のupdated_at/created_atが基準より古いか」
 * しか見ない。これは「前回成功時に処理して、以後ZAICO側で変わって
 * いない」ことの**十分条件ではない**——ある商品が、何らかの理由で
 * BELLOに一度も取り込まれないまま（実データで確認された例:
 * releaseSourceLinkの失敗で「リンクだけ残りInventoryが無い」不整合
 * (zaicoSyncPorts.tsのreleaseSourceLinkコメント参照)、あるいは
 * このdelta設計そのものが入る前の何らかの欠陥）、ZAICO側の
 * updated_atだけがたまたま古ければ、`needsSync`は「skipしてよい」と
 * 誤判定し続ける。次回以降の`since`はこの商品のupdated_atより常に
 * 新しくなる一方（`resolveDeltaSince`は前回**成功**時刻を進めるだけで、
 * 個々の商品のupdated_atには関知しない）なので、**一度この状態に
 * 落ちると自然には回復しない** —— 時刻ベースの判定だけを信じる限り
 * 恒久的な取りこぼしになる。
 *
 * `existsInBello`(省略可)は、この抜け穴を塞ぐための追加条件。
 * 「時刻だけ見ればskipしてよい」と判定された商品について、
 * 呼び出し元がBELLO側に実在するかどうかを追加で確認できるときだけ
 * 渡す——実在しない（＝BELLO未取込）なら、時刻がどれだけ古くても
 * `toProcess`へ回す。`existsInBello`を渡さない呼び出し（既存動作）は
 * 従来どおり時刻だけで判定する後方互換を保つ。
 *
 * コストの根拠は呼び出し側（`zaicoSyncPageProcessor.ts`/
 * `zaicoBackgroundSync.ts`）にある: `existsInBello`はO(1)のMap
 * ルックアップとして渡されることを前提にしており、この関数自体は
 * 追加のDB往復もAPI呼び出しも一切行わない（純粋関数のまま）。
 */
export function splitByDelta<T extends Pick<ZaicoInventory, "updated_at" | "created_at">>(
  items: T[],
  since: string | null,
  existsInBello?: (item: T) => boolean,
): DeltaSplit<T> {
  if (!since) return { toProcess: items, skipped: [] };
  const toProcess: T[] = [];
  const skipped: T[] = [];
  for (const item of items) {
    if (needsSync(item, since)) {
      toProcess.push(item);
      continue;
    }
    // 時刻だけでは「skipしてよい」と出たが、BELLO未取込である可能性を
    // 追加確認する。存在確認自体を省略できる(existsInBello未指定)なら
    // 従来どおりskip。確認できて、かつ存在しないなら、古い時刻でも
    // 取りこぼさず処理側へ回す。
    if (existsInBello && !existsInBello(item)) {
      toProcess.push(item);
      continue;
    }
    skipped.push(item);
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

/**
 * 完了した回の後、次回の差分基準を**進めてよいか**を決める。
 *
 * ── 2026-09-11 設計見直しで判明した取りこぼし ────────────────────
 *
 * 従来は「ページを全部辿り終えた(isDone)」だけを基準にlastSuccessfulSyncAt
 * を進めていた——1件でもsyncOneZaicoItemが`failed`を返していても、
 * ページ自体は完走扱いになるため基準が進んでいた。次回のDELTA同期は
 * `since`以降のupdated_atだけを見るので、失敗した商品のZAICO側updated_at
 * がその後変わらなければ、**次回以降ずっとsplitByDeltaでskip側に落ち、
 * 再試行の機会が永久に来ない**——「失敗商品を既読にして省き続ける」
 * という一番避けたい取りこぼし方。
 *
 * 直し方は、1件でも失敗があった回では基準を進めない、これだけ。
 * 次回は同じ(古い)`since`を使うので、失敗した商品を含め「前回成功時刻
 * 以降」がそのまま広めに再スキャン対象になる——重複再処理は安全
 * (syncOneZaicoItemは冪等)、取りこぼしより重複を選ぶという、この
 * ファイル全体を貫く方針そのもの。
 */
export function resolveNextSyncBasis(
  previousLastSuccessfulSyncAt: string | null,
  startedAt: string | null | undefined,
  finishedAtIso: string,
  hadFailures: boolean,
): string | null {
  if (hadFailures) return previousLastSuccessfulSyncAt;
  return nextSuccessfulSyncAt(startedAt, finishedAtIso);
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
