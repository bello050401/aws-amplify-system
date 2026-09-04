/**
 * 整合性監査の「前回との差分」判定（2026-09-04 最終フェーズ Phase B）。
 *
 * **純粋関数だけ。** AWSにもファイルにも触らない —— 判定そのものを
 * 実データ無しでテストできるようにするため。
 *
 * ── なぜ絶対件数で判定しないのか ────────────────────────────────
 *
 * 実データには「消してはいけない残骸」がある。たとえば存在しない在庫を
 * 指す在庫履歴が315件分あるが、これは2026-08-30のZAICO重複作成事故で
 * 消された在庫の履歴で、古物台帳として**残すべきもの**。
 *
 * これを毎回「異常315件」と出し続けると、そのうち誰も読まなくなる。
 * 見たいのは「315のままか」「316に増えたか」で、増えたときだけが事故。
 *
 * ── 判定 ────────────────────────────────────────────────────────
 *
 *   前回なし          → NEW      基準値を作るだけ。異常にしない
 *   現在 === 前回      → PASS
 *   現在 >  前回      → FAIL     新しい異常が増えた
 *   現在 <  前回      → WARNING  減った。修復か、検査対象の変化か、人が見る
 *
 * 減少をFAILにしないのは、正しい修復でも減るから。ただし黙って基準値を
 * 下げると「減った理由」が追えなくなるので、必ず記録に残す。
 *
 * ── 取得できなかった項目を0にしない ──────────────────────────────
 *
 * 走査に失敗した項目は `value: null` として渡す。その項目は ERROR とし、
 * **基準値を更新しない**。ここで0を入れてしまうと、次回に本物の異常が
 * 出たときへの基準が壊れる（0→1でFAILになるべきところが、実際には
 * 315件あるのに0が基準になってしまう）。取得の失敗と「0件」は別物。
 */

export type Verdict = "PASS" | "WARNING" | "FAIL" | "NEW" | "ERROR";

/** 1項目ぶんの測定値。走査に失敗したら value を null にする。 */
export interface IntegrityMetric {
  key: string;
  label: string;
  value: number | null;
  /** value が null のときの理由（秘密値は入れない）。 */
  error?: string;
}

/** 保存しておく基準値。 */
export interface IntegrityBaseline {
  /** 基準値を確定した時刻。 */
  updatedAt: string;
  /** key → 件数。 */
  values: Record<string, number>;
}

export interface MetricComparison {
  key: string;
  label: string;
  previous: number | null;
  current: number | null;
  delta: number | null;
  verdict: Verdict;
  note: string;
}

export interface IntegrityRunResult {
  runAt: string;
  comparisons: MetricComparison[];
  /** 全体の判定。1つでもFAILがあればFAIL、ERRORがあればERROR、… */
  overall: Verdict;
  /** 次回の基準値。**ERRORだった項目は前回値をそのまま引き継ぐ**（0で上書きしない）。 */
  nextBaseline: IntegrityBaseline;
  /** 通知すべきか。新しい異常（FAIL）が出たときだけ。 */
  shouldNotify: boolean;
  /** 通知の本文（1行）。shouldNotify が false なら null。 */
  notificationText: string | null;
}

function compareOne(metric: IntegrityMetric, baseline: IntegrityBaseline | null): MetricComparison {
  const previous = baseline && Object.prototype.hasOwnProperty.call(baseline.values, metric.key) ? baseline.values[metric.key] : null;

  if (metric.value === null) {
    return {
      key: metric.key,
      label: metric.label,
      previous,
      current: null,
      delta: null,
      verdict: "ERROR",
      note: metric.error ? `取得できませんでした: ${metric.error}` : "取得できませんでした。",
    };
  }
  if (previous === null) {
    return { key: metric.key, label: metric.label, previous: null, current: metric.value, delta: null, verdict: "NEW", note: "初回。この値を基準にします。" };
  }
  const delta = metric.value - previous;
  if (delta === 0) {
    return { key: metric.key, label: metric.label, previous, current: metric.value, delta: 0, verdict: "PASS", note: "前回と同じ。" };
  }
  if (delta > 0) {
    return {
      key: metric.key,
      label: metric.label,
      previous,
      current: metric.value,
      delta,
      verdict: "FAIL",
      note: `${delta}件増えました。新しい異常です。`,
    };
  }
  return {
    key: metric.key,
    label: metric.label,
    previous,
    current: metric.value,
    delta,
    verdict: "WARNING",
    note: `${-delta}件減りました。修復されたのか、検査対象が変わったのかを確認してください。`,
  };
}

/** 全体の判定。悪いほうを採る。 */
function overallVerdict(comparisons: MetricComparison[]): Verdict {
  if (comparisons.some((c) => c.verdict === "FAIL")) return "FAIL";
  if (comparisons.some((c) => c.verdict === "ERROR")) return "ERROR";
  if (comparisons.some((c) => c.verdict === "WARNING")) return "WARNING";
  if (comparisons.every((c) => c.verdict === "NEW")) return "NEW";
  return "PASS";
}

export function compareIntegrity(
  metrics: IntegrityMetric[],
  baseline: IntegrityBaseline | null,
  runAt: string,
): IntegrityRunResult {
  const comparisons = metrics.map((m) => compareOne(m, baseline));

  // 次回の基準値。
  //   ・値が取れた項目 → その値
  //   ・取れなかった項目 → **前回値を引き継ぐ**（0で上書きしない）
  //   ・前回も無い項目 → 基準値に載せない（次回また NEW になる）
  const values: Record<string, number> = {};
  for (const c of comparisons) {
    if (c.current !== null) values[c.key] = c.current;
    else if (c.previous !== null) values[c.key] = c.previous;
  }
  // 今回測っていない過去の項目も落とさない（検査項目を一時的に外しても
  // 基準値が消えないように）。
  if (baseline) {
    for (const [k, v] of Object.entries(baseline.values)) {
      if (!(k in values)) values[k] = v;
    }
  }

  const overall = overallVerdict(comparisons);
  const failed = comparisons.filter((c) => c.verdict === "FAIL");
  const errored = comparisons.filter((c) => c.verdict === "ERROR");

  // 通知するのは「新しい異常」のときだけ。正常時に毎回送らない。
  // 取得できなかった（＝検査できていない）ことも、黙っていると
  // 「異常なし」と区別が付かないので通知する。
  const shouldNotify = failed.length > 0 || errored.length > 0;
  const notificationText = shouldNotify
    ? [
        failed.length > 0 ? `整合性の異常を検知しました（${failed.length}項目）` : "整合性の検査が完了しませんでした",
        ...failed.map((c) => `・${c.label}: ${c.previous} → ${c.current}（+${c.delta}）`),
        ...errored.map((c) => `・${c.label}: ${c.note}`),
      ].join("\n")
    : null;

  return {
    runAt,
    comparisons,
    overall,
    nextBaseline: { updatedAt: runAt, values },
    shouldNotify,
    notificationText,
  };
}

/** 実行履歴の1行。後から同じ異常を追跡できるだけの情報を持つ。 */
export interface IntegrityHistoryEntry {
  runAt: string;
  overall: Verdict;
  metrics: { key: string; label: string; previous: number | null; current: number | null; delta: number | null; verdict: Verdict }[];
}

export function toHistoryEntry(result: IntegrityRunResult): IntegrityHistoryEntry {
  return {
    runAt: result.runAt,
    overall: result.overall,
    metrics: result.comparisons.map((c) => ({
      key: c.key,
      label: c.label,
      previous: c.previous,
      current: c.current,
      delta: c.delta,
      verdict: c.verdict,
    })),
  };
}

/** 人が読む1回ぶんの表。 */
export function formatRunResult(result: IntegrityRunResult): string {
  const mark: Record<Verdict, string> = { PASS: "✓", WARNING: "△", FAIL: "✗", NEW: "・", ERROR: "!" };
  const lines = [`[${result.overall}] ${result.runAt}`, ""];
  const width = Math.max(...result.comparisons.map((c) => c.label.length), 10);
  for (const c of result.comparisons) {
    const prev = c.previous === null ? "—" : String(c.previous);
    const cur = c.current === null ? "—" : String(c.current);
    const delta = c.delta === null ? "" : c.delta > 0 ? ` (+${c.delta})` : c.delta < 0 ? ` (${c.delta})` : "";
    lines.push(`${mark[c.verdict]} ${c.label.padEnd(width)}  ${prev} → ${cur}${delta}  ${c.note}`);
  }
  return lines.join("\n");
}
