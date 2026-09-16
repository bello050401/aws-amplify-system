// Safe-display metrics summary for a cooperative eco run.
//
// The runtime does not (yet) record per-phase token/cost breakdowns or
// cache-reuse counters. This helper never invents numbers to fill that gap:
// anything not actually measured is reported as unknown, not as zero or a
// saved percentage. Cost figures are always labelled as API-equivalent
// values, never as contract billing or remaining quota.

const COST_NOTE =
  "API換算のUSD値です。Claude/GPTの契約請求額や利用枠(quota)の残量ではありません。開発quotaや月額のお問い合わせ費用とは別の数値です。";
const REUSE_NOTE =
  "キャッシュの再利用・節約率は現時点で計測されていません。未計測を0件や100%節約とは表示しません。";

function safeUsage(usage) {
  const measured = Number.isFinite(usage?.measuredTokens) && usage.measuredTokens >= 0 ? usage.measuredTokens : 0;
  const estimated = Number.isFinite(usage?.estimatedTokens) && usage.estimatedTokens >= 0 ? usage.estimatedTokens : 0;
  const source =
    measured > 0 && estimated > 0 ? "mixed" : measured > 0 ? "measured" : estimated > 0 ? "estimated" : "unknown";
  return { measured, estimated, source };
}

function safeCost(usage) {
  const valueUsd = Number.isFinite(usage?.costUsd) && usage.costUsd >= 0 ? usage.costUsd : 0;
  return { valueUsd, known: usage?.costKnown === true, note: COST_NOTE };
}

export function summarizeEcoMetrics(run, { checkpoints = [] } = {}) {
  if (!run || typeof run !== "object") throw Error("Run required");
  const list = Array.isArray(checkpoints) ? checkpoints : [];
  const phaseCounts = {};
  const duplicateOperations = [];
  const seen = new Set();
  for (const entry of list) {
    const phase = typeof entry?.phase === "string" && entry.phase ? entry.phase : "unknown";
    phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
    const key = phase + "@" + (entry?.at ?? "");
    if (seen.has(key)) duplicateOperations.push(phase);
    seen.add(key);
  }
  return {
    tokens: safeUsage(run.usage),
    cost: safeCost(run.usage),
    reuse: { reusedOperations: null, unknown: true, note: REUSE_NOTE },
    operations: {
      total: list.length,
      phaseCounts,
      duplicateOperations,
      note: duplicateOperations.length
        ? "同一チェックポイントの重複記録があります。二重カウントに注意してください。"
        : null,
    },
    repair: {
      count: Number.isInteger(run.repairCount) ? run.repairCount : 0,
      logicalFailures: Number.isInteger(run.logicalFailures) ? run.logicalFailures : 0,
      communicationFailures: Number.isInteger(run.communicationFailures) ? run.communicationFailures : 0,
      artifactFailures: Number.isInteger(run.artifactFailures) ? run.artifactFailures : 0,
    },
  };
}
