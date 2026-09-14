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
 *
 * ── 2026-09-14 追記: 恒久的に失敗する商品も時刻だけでは救えない ─────
 *
 * `isPersistentlyFailing`(省略可)は`existsInBello`と同じ形の第3の
 * 安全弁。ある商品が同期のたびに(データ不整合等の理由で)`failed`に
 * なり続け、かつZAICO側`updated_at`が以後変わらない場合、時刻だけの
 * 判定ではその商品は恒久的にskip対象へ落ちる——`existsInBello`は
 * 「BELLOに実在するか」しか見ないので、この商品はBELLOに実在する
 * (作成済みだが更新が失敗し続けている等)ケースでは救えない。
 * 呼び出し元が`nextFailedRetryIds`で永続化した「恒久失敗リスト」の
 * 所属確認を渡すと、時刻がどれだけ古くても`toProcess`へ強制的に回る
 * ——`existsInBello`と同じくO(1)のSetルックアップを前提にしており、
 * この関数自体は追加のDB往復を行わない。
 */
export function splitByDelta<T extends Pick<ZaicoInventory, "updated_at" | "created_at">>(
  items: T[],
  since: string | null,
  existsInBello?: (item: T) => boolean,
  isPersistentlyFailing?: (item: T) => boolean,
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
    // 恒久失敗リストに載っている商品も、同じ理由で時刻を無視して
    // 強制的に再試行へ回す(成功するまでこのリストから外れない)。
    if (isPersistentlyFailing && isPersistentlyFailing(item)) {
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
 * 直し方(2026-09-11)は、1件でも失敗があった回では基準を進めない、
 * これだけだった。次回は同じ(古い)`since`を使うので、失敗した商品を
 * 含め「前回成功時刻以降」がそのまま広めに再スキャン対象になる——
 * 重複再処理は安全(syncOneZaicoItemは冪等)、取りこぼしより重複を選ぶ
 * という、このファイル全体を貫く方針そのもの。
 *
 * ── 2026-09-14 再修正: 「1件でも失敗があれば止める」が新たな取りこぼし方を生んだ ──
 *
 * ある商品が**恒久的に**(データ不整合など再試行しても直らない理由で)
 * 失敗し続ける場合、`hadFailures`は毎回trueになり続け、**基準が永久に
 * nullのまま固着する**——「差分同期が毎回『初回のため全件』になる」
 * 不具合そのもの。1件の恒久失敗が全件を巻き添えにしてしまっていた。
 *
 * 第4引数の意味を「今回failedがあったか」から「**再試行の保証が無い
 * failedがあったか**」へ変える。失敗した商品のsourceIdを
 * `nextFailedRetryIds`で永続化し、次回以降`splitByDelta`の
 * `isPersistentlyFailing`経由で基準に関係なく強制再試行する仕組みが
 * ある場合、その失敗はこの関数にとってはもう「未解決」ではない
 * (成功するまで確実に再試行され続けることが保証されている)——
 * 呼び出し元はそのケースで`false`を渡してよい。基準は他の正常な商品
 * のために前進し、恒久失敗の商品だけが個別に再試行され続ける。
 *
 * ── 移行安全性(`hasUncapturedLegacyFailures`) ─────────────────────
 *
 * 上記の「`false`を渡してよい」が成り立つのは、その失敗が実際に
 * `failedSourceIds`へ捕捉されている場合だけ。この仕組みが導入される
 * **前から実行中だったジョブ**は、それ以前に積んだ`failed`カウントの
 * sourceIdを一度もこのリストへ書けていない——呼び出し元はその状態
 * (`hasUncapturedLegacyFailures`参照)でも`false`を渡してしまうと、
 * 捕捉保証の無い失敗を巻き込んで基準を前進させ、恒久的な取りこぼしに
 * なる。呼び出し元は必ず`hasUncapturedLegacyFailures`の結果を第4引数へ
 * 反映すること。
 *
 * ── 2026-09-14 (task_ff42042dfee35233e9) 再々修正: 「trusted」自体が
 *    checkpointを跨いで化ける不具合 ──────────────────────────────
 *
 * 上記2点(移行安全性の導入)には、1 invocationでジョブが完了する
 * ケースしか実境界試験で確認されていない、という穴があった。
 * `failedSourceIds`は**中間(RUNNING)checkpointでも毎回書き込む**
 * (ページ内時間切れ・ページ跨ぎのいずれでも)——このとき書く値が
 * 「配列としてparseできるかどうか」だけでtrustedを決めていると、
 * 旧RUNNING job(failedSourceIds未設定、既存failedカウントあり)が
 * **完了に至る前の中間checkpoint**を1回書いただけで、その書き込み
 * 自体が(中身が空配列であっても)「有効なJSON配列」になってしまい、
 * 次のLambda invocation(=同じjobの続き、あるいは全くの別invocation)
 * は`trusted: true`と誤認する。その時点では旧failedカウントの
 * sourceIdはまだ一切捕捉されていない——にも関わらず後続のinvocation
 * は`hasUncapturedLegacyFailures(true, ...)`が`false`を返すため、
 * 完了時に基準を前進させてしまい、旧失敗を永久に取りこぼす
 * (`parseFailedRetryIds`/`nextFailedSourceIdsTrusted`のコメント参照)。
 *
 * 直し方: 「trusted」を配列の見た目から推測せず、`failedSourceIds`の
 * 保存形式そのものに**明示的なtrustedフラグ**として持たせ
 * (`serializeFailedRetryState`)、そのフラグは
 * 「既にtrusted」→そのまま維持(sticky)、「まだuntrusted」→
 * **`since === null`(=時刻を無視して全件を強制的に処理し切った、
 * 本物のFULL相当の完走)を伴う完了(isDone)のときだけ**新たにtrusted化
 * する、というルールへ変更した(`nextFailedSourceIdsTrusted`)。DELTAの
 * 途中checkpoint・DELTAの完了はどちらも「trustedを新たに立てる」条件を
 * 満たさない——`since`ベースの再スキャンだけでは、旧failedのZAICO側
 * `updated_at`が動いていない限り再捕捉できる保証が無いため。
 */
export function resolveNextSyncBasis(
  previousLastSuccessfulSyncAt: string | null,
  startedAt: string | null | undefined,
  finishedAtIso: string,
  hadUnretriedFailures: boolean,
): string | null {
  if (hadUnretriedFailures) return previousLastSuccessfulSyncAt;
  return nextSuccessfulSyncAt(startedAt, finishedAtIso);
}

/** `nextFailedRetryIds`が受け取る、1件分の処理結果。 */
export interface ProcessedItemOutcome {
  zaicoId: string;
  failed: boolean;
}

/**
 * 次回以降「時刻に関係なく強制再試行する」sourceId集合(恒久失敗リスト)
 * を計算する純粋関数。DBにもZAICOにも触らない。
 *
 * - 今回`failed`だった商品は追加する(次回、基準がどれだけ進んでも
 *   `splitByDelta`の`isPersistentlyFailing`で強制的に再試行される)。
 * - 今回`failed`以外(created/updated/unchanged)だった商品は除去する
 *   ——リトライが成功した(または元々問題なかった)ので、もう強制する
 *   必要はない。
 * - 今回**処理していない**(まだ恒久失敗リストに残っている)商品には
 *   触れない——ページ内時間切れ等でまだ処理機会が回ってきていないだけ
 *   なので、リストから外すと次回の強制再試行の権利ごと失われる。
 *
 * 呼び出し元は1 invocation内の複数ページ/複数バッチに渡って、この
 * 関数の戻り値を次の呼び出しの`previousFailedSourceIds`としてそのまま
 * 引き継ぐ(zaicoSyncPageProcessor.tsの`processedOutcomes`が「実際に
 * syncOneZaicoItemを呼んだ商品」だけを返すため、skipされた商品を
 * 誤って成功扱いで消してしまうことはない)。
 */
export function nextFailedRetryIds(
  previousFailedSourceIds: ReadonlySet<string>,
  processed: readonly ProcessedItemOutcome[],
): Set<string> {
  const next = new Set(previousFailedSourceIds);
  for (const p of processed) {
    if (p.failed) next.add(p.zaicoId);
    else next.delete(p.zaicoId);
  }
  return next;
}

/** `parseFailedRetryIds`の戻り値。 */
export interface ParsedRetryIds {
  /** 実際にparseできたsourceId集合(未設定/破損時は空)。 */
  ids: Set<string>;
  /**
   * このフィールドが「確定的に空(=既知の失敗は無い)」であることを
   * 意味してよいか。false は「未設定/破損/信頼できない」——**空だが
   * 信頼できない**ことを示す(下記コメント参照)。
   */
  trusted: boolean;
}

/**
 * `ZaicoSyncJob.failedSourceIds`へ書き込む内部表現。バージョン管理は
 * 意図的に持たない——このフィールド自体がまだ未公開(d95d476時点で
 * 本番未反映)なので、旧形式との互換読み取りは「壊れず読める」以上の
 * 保証を必要としない。
 */
interface StoredFailedRetryState {
  ids: string[];
  /**
   * task_ff42042dfee35233e9: 「配列としてparseできた」こと自体を
   * trustedの根拠にしない(このファイル冒頭resolveNextSyncBasisの
   * 「再々修正」コメント参照)。trustedは常にこのフィールドの値として
   * 明示的に運ぶ。
   */
  trusted: boolean;
}

/**
 * `ids`をJSON配列として書き込む前に必ずこの関数を通す
 * (`JSON.stringify(Array.from(ids))`を直接呼ばない)。`trusted`は
 * `nextFailedSourceIdsTrusted`の戻り値をそのまま渡すこと。
 */
export function serializeFailedRetryState(ids: ReadonlySet<string>, trusted: boolean): string {
  const state: StoredFailedRetryState = { ids: Array.from(ids), trusted };
  return JSON.stringify(state);
}

function extractStringIds(raw: readonly unknown[]): { ids: Set<string>; allStrings: boolean } {
  const strings = raw.filter((v): v is string => typeof v === "string");
  return { ids: new Set(strings), allStrings: strings.length === raw.length };
}

/**
 * `ZaicoSyncJob.failedSourceIds`の読み取り。`parseSeenSourceIds`(既存
 * のseenSourceIds/missingSourceIdsの規約)と違い、「読めなかった」と
 * 「確定的に空」を区別して返す——両方を空Setへ倒して構わないのは
 * seenSourceIdsだけで、failedSourceIdsは`hasUncapturedLegacyFailures`
 * の入力になるため、この区別自体が移行安全性の核。
 *
 * - `undefined`/`null`(フィールド未設定): この機能が導入される前の
 *   行、またはこの行にまだ一度も書き込みが無い。`trusted: false`。
 * - JSON.parseが失敗する破損文字列: 空とは違う。`trusted: false`。
 *   (2026-09-14: raw値そのものはログに出さない——リトライ集合の中身
 *   はZAICO在庫IDの列挙であり、エラーログへ丸ごと出す情報ではない。
 *   長さだけを記録する。)
 * - `{ ids, trusted }`形式以外(旧形式の裸配列を含む): `ids`は救出できる
 *   限り取り出すが、`trusted`は常に`false`として扱う——「配列として
 *   parseできた」だけではtrustedの根拠にしない(このファイル冒頭
 *   resolveNextSyncBasisコメント参照)。
 * - `ids`配列に非文字列が混じっている場合: 黙ってfilterして`trusted`を
 *   素通りさせない——破損の兆候として`trusted: false`へ倒し、件数だけ
 *   ログに残す(2026-09-14 (task_ff42042dfee35233e9)。中身は出さない)。
 * - `{ ids: string[], trusted: true }`(このモジュールが書いた形): その
 *   ままの`trusted`を返す。
 */
export function parseFailedRetryIds(raw: unknown): ParsedRetryIds {
  if (raw === undefined || raw === null) return { ids: new Set(), trusted: false };
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`[ZaicoSyncJob.failedSourceIds] failed to JSON.parse stored value (length=${raw.length})`);
      return { ids: new Set(), trusted: false };
    }
    return parseFailedRetryIds(parsed);
  }
  if (Array.isArray(raw)) {
    // 旧形式(裸の配列)。中身は救出するが、trustedはこの形からは
    // 絶対に昇格させない。
    const { ids, allStrings } = extractStringIds(raw);
    if (!allStrings) {
      console.error(`[ZaicoSyncJob.failedSourceIds] stored array contains non-string entries (count=${raw.length})`);
    }
    return { ids, trusted: false };
  }
  if (typeof raw === "object" && Array.isArray((raw as { ids?: unknown }).ids)) {
    const state = raw as { ids: unknown[]; trusted?: unknown };
    const { ids, allStrings } = extractStringIds(state.ids);
    if (!allStrings) {
      // 非文字列が混じっている = 破損。黙ってfilterしてtrustedを通す
      // (=取りこぼしを見えなくする)ことはしない——安全側でuntrusted化する。
      console.error(`[ZaicoSyncJob.failedSourceIds] stored ids contain non-string entries (count=${state.ids.length}); treating as untrusted`);
      return { ids, trusted: false };
    }
    return { ids, trusted: state.trusted === true };
  }
  console.error("[ZaicoSyncJob.failedSourceIds] unexpected stored shape (neither array nor {ids,trusted} object)");
  return { ids: new Set(), trusted: false };
}

/**
 * 次にcheckpointへ書き込む`trusted`の値。「配列としてparseできるか」
 * では決めない(このファイル冒頭resolveNextSyncBasisコメント参照)。
 *
 * - 既にtrustedなら、以後もずっとtrusted(sticky)。一度確立した信頼は
 *   後戻りしない。
 * - まだuntrustedなら、**`since === null`を伴う完了(isDone)のとき
 *   だけ**新たにtrusted化する。`since === null`は「時刻を無視して
 *   今回すべての商品を強制的に処理し切った」ことを意味する
 *   (`splitByDelta`の`!since`早期return参照)——このときだけ、旧
 *   failedカウントのsourceIdが(もしまだ実際に失敗し続けているなら)
 *   確実に`nextFailedRetryIds`で捕捉されたと言える。DELTAの途中
 *   checkpoint・DELTAの完了はどちらもこの条件を満たさない——時刻ベース
 *   の再スキャンだけでは、旧failedのZAICO側`updated_at`が動いていない
 *   限り再捕捉できる保証が無いため、untrustedのまま基準前進を止め
 *   続ける(次回も安全に同じ範囲を再スキャンする)。
 */
export function nextFailedSourceIdsTrusted(initialTrusted: boolean, since: string | null, isDone: boolean): boolean {
  if (initialTrusted) return true;
  return since === null && isDone;
}

/**
 * 「捕捉保証のない既存失敗が残っているか」——`resolveNextSyncBasis`の
 * 第4引数として渡す値そのもの。
 *
 * ── なぜ必要か(task_8ff5754e48711a753a、2026-09-14境界修正) ─────
 *
 * `failedSourceIds`が導入される前から実行中(RUNNING)だったジョブは、
 * それ以前に積んだ`failed`カウントのsourceIdを一度もこのフィールドへ
 * 書けていない(`parseFailedRetryIds`の`trusted: false`)。この状態を
 * 「恒久失敗リストは空(=既知の失敗は無い)」と混同して基準を前進させると、
 * その旧失敗商品は(基準前進後は時刻ベース判定で永久にskip、かつ
 * 恒久失敗リストにも載っていないので強制再試行の対象にもならない)、
 * 取りこぼしたまま気づけなくなる。
 *
 * 直し方: `trusted`が`false`で、かつ今回までに`failed`カウントが
 * 1件以上ある(=捕捉できていない失敗が実在する可能性がある)ときだけ
 * `true`を返す。呼び出し元はこの回の基準前進を見送り、次回は同じ
 * (前進していない)`since`で安全に再スキャンする——`nextFailedSourceIdsTrusted`
 * が定める条件を満たすまでこのフィールドは`trusted: false`のまま
 * 書き込まれ続けるので(空でも有効なJSONだが`trusted`は立たない)、
 * この経路は「本物の全件再捕捉」が起きるまで自己解消しない
 * (2026-09-14 task_ff42042dfee35233e9で「配列が書ければtrusted」
 * という誤った早期解消を修正済み)。
 *
 * `trusted`かつ`failed`が0件のとき(=このフィールドが未設定でも、
 * 過去に一度も失敗が無い正常な新規ジョブ)は`false`を返す——新規
 * ジョブまで巻き添えにして基準前進を止めない。
 */
export function hasUncapturedLegacyFailures(trusted: boolean, failedCountSoFar: number): boolean {
  return !trusted && failedCountSoFar > 0;
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

/**
 * 人が読む1行。ログにも画面にも同じ文言を出す。
 *
 * 2026-09-14: `since`がnullのケースを「初回のため全件」と断定しない。
 * `since`は`lastSuccessfulSyncAt`(前回**成功**時刻)が無いときに常にnull
 * になる——これは文字どおりの初回だけでなく、恒久失敗リストの導入前は
 * 「過去に一度も完走していない(何度試みても失敗し続けた)」ケースでも
 * 起こり得た。実行契機を確認していないのに「初回」と言い切ると、実際
 * には過去に何度も失敗している状況を利用者が誤解しかねない。
 */
export function describeRun(s: SyncRunSummary): string {
  const ms = elapsedMs(s.startedAt, s.finishedAt);
  const time = ms === null ? "計測不可" : `${(ms / 1000).toFixed(1)}秒`;
  const label = s.mode === "DELTA" ? "差分同期" : "全件同期";
  const since = s.mode === "DELTA" ? (s.since ? `（${s.since} 以降）` : "（前回成功した同期の記録が無いため全件）") : "";
  return (
    `${label}${since}: ` +
    `取得${s.fetched}件 / 新規${s.created} 更新${s.updated} 変更なし${s.unchanged} ` +
    `差分スキップ${s.skippedByDelta} 失敗${s.failed} / ${time}`
  );
}
