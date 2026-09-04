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
