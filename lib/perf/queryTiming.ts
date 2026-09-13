import { AsyncLocalStorage } from "node:async_hooks";

/**
 * サーバー側のデータアクセスを1本ずつ計測する(2026-09-04 性能総点検 §12)。
 *
 * ── なぜ「画面ごとに手で計測を書く」形にしないのか ──────────────
 *
 * 画面は今後も増える。計測を各ページへ書く形にすると、新しい画面には
 * 付いてこない —— **遅くなったことを検知できるようにする**のが §12 の
 * 目的なので、それでは意味が無い。
 *
 * データアクセスは全て `serverDataClient.models.X.op()` を通る。
 * そこを1箇所で包めば、どの画面からでも自動的に記録される。
 *
 * ── 本番では何も出さない ────────────────────────────────────────
 *
 * §12「本番ユーザーへ不要なデバッグ情報は表示しない」。
 * 既定は**無効**で、`BELLO_QUERY_TIMING=1` を明示したときだけ動く。
 * 無効時は記録もしないので、包んだことによる負荷も実質ゼロ
 * (関数呼び出し1つと真偽値の判定だけ)。
 */

export interface QueryTiming {
  /** モデル名(Inventory / Category …)。 */
  model: string;
  /** 操作(list / get / create …)。 */
  op: string;
  ms: number;
  /** 返ってきた件数(分かる場合)。 */
  items: number | null;
}

interface Collector {
  label: string;
  startedAt: number;
  timings: QueryTiming[];
}

const store = new AsyncLocalStorage<Collector>();

/** 計測が有効か。既定は無効(本番で何も出さないため)。 */
export function isQueryTimingEnabled(): boolean {
  return process.env.BELLO_QUERY_TIMING === "1";
}

/**
 * 1つの処理(=1画面の描画、1 Server Action)を囲んで、その中の
 * データアクセスをまとめて記録する。
 *
 * 無効時は `fn()` をそのまま呼ぶだけ。**戻り値も例外も一切変えない。**
 */
export async function withQueryTiming<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!isQueryTimingEnabled()) return fn();
  const collector: Collector = { label, startedAt: performance.now(), timings: [] };
  try {
    return await store.run(collector, fn);
  } finally {
    report(collector);
  }
}

/** データアクセス1本の記録。計測が無効、または囲まれていなければ何もしない。 */
export function recordQuery(timing: QueryTiming): void {
  store.getStore()?.timings.push(timing);
}

/**
 * いま記録されている内容(呼び出し側が独自に出したい場合)。
 * 囲まれていなければ空。
 */
export function currentQueryTimings(): QueryTiming[] {
  return store.getStore()?.timings.slice() ?? [];
}

/**
 * 記録をまとめて1行ずつ出す。
 *
 * **合計と往復回数を必ず出す。** どれか1本が遅いのか、細かいのが並んで
 * いるのかで、直すべき場所がまるで違う。
 */
function report(collector: Collector): void {
  const totalMs = performance.now() - collector.startedAt;
  const dbMs = collector.timings.reduce((s, t) => s + t.ms, 0);
  const lines = [
    `[perf] ${collector.label} — 合計 ${Math.round(totalMs)}ms / データアクセス ${collector.timings.length}本 計${Math.round(dbMs)}ms`,
  ];
  for (const t of [...collector.timings].sort((a, b) => b.ms - a.ms)) {
    lines.push(`  ${String(Math.round(t.ms)).padStart(6)}ms  ${t.model}.${t.op}${t.items != null ? ` (${t.items}件)` : ""}`);
  }
  console.info(lines.join("\n"));
}

/**
 * `Server-Timing` ヘッダの値。ブラウザの開発者ツールで見られる形。
 *
 * 秘密になりうる値(検索条件・IDなど)は入れない —— モデル名と操作名と
 * 所要時間だけ。
 */
export function serverTimingHeader(): string | null {
  const collector = store.getStore();
  if (!collector) return null;
  const parts = collector.timings.map((t, i) => `db${i};desc="${t.model}.${t.op}";dur=${Math.round(t.ms)}`);
  parts.push(`total;dur=${Math.round(performance.now() - collector.startedAt)}`);
  return parts.join(", ");
}

/**
 * 同じ `model.op` の複数エントリを1本へまとめた累積値(2026-09-13 EC計測
 * レビュー補正)。
 *
 * ── これは壁時計の待ち時間ではない ──────────────────────────────
 *
 * カテゴリ別GSIのように「対象を並列に取得し、それぞれが独自にページを
 * 辿る」処理は、同じ `model.op` への複数の往復が**同時に**進んでいる
 * ことがある(例: listEcEligibleInventoryはカテゴリごとに
 * `Promise.all`で並列に投げる)。ここで返す `ms` はそれらの所要時間を
 * 単純合計した値であり、実際にユーザーが待った時間(壁時計)より
 * 大きくなり得る —— 「DynamoDB往復に使ったCPU/IO時間の総量」と
 * 「利用者が体感した待ち時間」は別の数字であり、混同しない
 * (呼び出し側が「壁時計の段階待ち時間」を知りたい場合は`measureStage`
 * を使う)。
 *
 * それでも役に立つ理由: 往復回数(`count` = ページ数)と合計msは、
 * 「その model.op がどれだけDBを叩いたか」の総量として意味がある——
 * 段階の壁時計時間とは区別した上で、参考値として一緒に返す。
 */
export interface OpGroupSummary {
  /** `${model}.${op}`。画面固有のラベルは呼び出し側で被せる。 */
  key: string;
  /** その`model.op`への往復(ページ)回数。 */
  count: number;
  /** 合計所要時間(ms)。並列に走った分もそのまま加算されるため壁時計ではない。 */
  ms: number;
  /** 1本でも失敗(items===null)していれば false。 */
  ok: boolean;
}

export function groupTimingsByOp(timings: QueryTiming[]): OpGroupSummary[] {
  const byKey = new Map<string, OpGroupSummary>();
  for (const t of timings) {
    const key = `${t.model}.${t.op}`;
    const g = byKey.get(key) ?? { key, count: 0, ms: 0, ok: true };
    g.count += 1;
    g.ms += t.ms;
    if (t.items === null) g.ok = false;
    byKey.set(key, g);
  }
  return [...byKey.values()];
}

/** `measureStage`が返す、1つの段階ぶんの壁時計計測結果。 */
export interface StageTiming {
  /** 呼び出し側が付ける固定ラベル(商品名・IDなど動的な値は入れない)。 */
  stage: string;
  /** そのステージ自体の壁時計経過時間(ms)。内部が並列/直列どちらでも、実際に待たれた時間をそのまま表す。 */
  elapsedMs: number;
  ok: boolean;
}

/**
 * 並列に走る複数の段階それぞれを、個別に壁時計で計測する
 * (2026-09-13 EC計測レビュー補正)。
 *
 * ── `groupTimingsByOp`と役割が違う ──────────────────────────────
 *
 * `groupTimingsByOp`は「同じmodel.opへの複数往復のms/回数」を合計する
 * ── 並列に走れば実際の待ち時間より大きくなり得る。こちらは逆に、
 * 「この段階(=1つの`fn`)を開始してから終わるまで、実際に何ms
 * 待たれたか」を1本だけ記録する——段階の内部でDynamoDBへ何回・どんな
 * 順序で往復していても関係なく、壁時計そのもの。
 *
 * ── 失敗しても他の段階の計測を巻き込まない ──────────────────────
 *
 * `fn`が投げた例外はここで捕まえ、`{ ok: false, error }`として返す
 * (投げ直さない)——`Promise.all`で複数の`measureStage`呼び出しを
 * 束ねても、どれか1つの失敗で他の段階の計測(進行中だった分)が
 * 失われない(2026-09-13 EC計測レビュー補正の核心: 「fetchがthrowすると
 * 計測結果を組み立てず、失敗段階が消える」問題への対処)。呼び出し側は
 * `ok`を見て、通常の一覧の例外契約(失敗したら投げる)をどこで再現する
 * か自分で決める——この関数自体は投げない。
 */
export async function measureStage<T>(
  stage: string,
  fn: () => Promise<T>,
): Promise<{ timing: StageTiming } & ({ ok: true; value: T } | { ok: false; error: unknown })> {
  const startedAt = performance.now();
  try {
    const value = await fn();
    return { ok: true, value, timing: { stage, elapsedMs: Math.round(performance.now() - startedAt), ok: true } };
  } catch (error) {
    return { ok: false, error, timing: { stage, elapsedMs: Math.round(performance.now() - startedAt), ok: false } };
  }
}

const STAGE_ERROR_TIMINGS = Symbol("bello.stageTimings");

/**
 * 失敗した処理の例外へ、そこまでに集まった段階別計測(`measureStage`が
 * 返した`timing`の配列)を添える(2026-09-13 EC計測レビュー補正)。
 *
 * 元の例外の型・`message`・`instanceof`判定は一切変えない(非enumerable
 * な追加プロパティとして載せるだけ) —— 呼び出し元の既存の例外契約
 * (「失敗したら投げる」)に影響しない、読み取り専用の付加情報。
 * `error`がオブジェクトでない(文字列throw等)場合は何もしない —— 呼び
 * 出し側は`getStageTimings`が空配列を返すことで「段階情報は無いが失敗
 * 自体は分かる」を扱える。
 */
export function attachStageTimings(error: unknown, stages: StageTiming[]): unknown {
  if (error && typeof error === "object") {
    Object.defineProperty(error, STAGE_ERROR_TIMINGS, { value: stages, configurable: true, enumerable: false });
  }
  return error;
}

/** `attachStageTimings`で添えた段階別計測を取り出す。無ければ空配列。 */
export function getStageTimings(error: unknown): StageTiming[] {
  if (error && typeof error === "object" && STAGE_ERROR_TIMINGS in error) {
    return (error as Record<typeof STAGE_ERROR_TIMINGS, StageTiming[]>)[STAGE_ERROR_TIMINGS];
  }
  return [];
}
