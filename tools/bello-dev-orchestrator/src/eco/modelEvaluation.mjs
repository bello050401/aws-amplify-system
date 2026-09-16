import crypto from "node:crypto";

export function evaluateAnswer(trial, answer) {
  if (
    !answer ||
    typeof answer.answer !== "string" ||
    Object.keys(answer).length !== 1
  )
    return { passed: false, reason: "Invalid answer envelope" };
  return {
    passed: answer.answer === trial.expected,
    reason:
      answer.answer === trial.expected
        ? "Exact independent assertion passed"
        : "Independent assertion failed",
  };
}

// Trial results are host-owned. An Agent's claim that it passed is never scored.
// One invocation is one sample; repeated IDs and batches do not inflate evidence.
export function summarizeTrials({
  provider,
  model,
  category,
  baselineModel,
  baselinePassRate,
  trials,
  evaluatedAt = new Date().toISOString(),
}) {
  if (!trials.length || new Set(trials.map((t) => t.id)).size !== trials.length)
    throw Error("Unique independent trials required");
  if (
    trials.some(
      (t) =>
        t.provider !== provider ||
        t.model !== model ||
        t.category !== category ||
        t.invocations !== 1,
    )
  )
    throw Error("Mixed or batched trials cannot qualify");
  const passed = trials.filter((t) => t.passed).length;
  const known = trials.every(
    (t) => Number.isFinite(t.totalTokens) && t.totalTokens > 0,
  );
  const ids = trials
    .map((t) => ({
      id: t.id,
      promptHash: t.promptHash,
      expectedHash: t.expectedHash,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    evaluatedAt,
    samples: trials.length,
    passRate: passed / trials.length,
    baselinePassRate,
    baselineModel,
    safetyFailures: trials.filter((t) => t.unexpectedToolUse).length,
    meanAttempts: 1,
    meanUsagePerAttempt: known
      ? trials.reduce((s, t) => s + t.totalTokens, 0) / trials.length
      : null,
    usageUnit: "total_tokens_including_cache",
    evaluationSet: crypto
      .createHash("sha256")
      .update(JSON.stringify(ids))
      .digest("hex"),
    meanDurationMs:
      trials.reduce((s, t) => s + t.durationMs, 0) / trials.length,
    pilotOnly: trials.length < 30,
  };
}

export function parseCliResult(provider, result, outputText) {
  if (!result.ok)
    return {
      ok: false,
      reason:
        result.reason ||
        result.stderr ||
        result.stdout?.slice(-2000) ||
        "CLI failed",
    };
  try {
    if (provider === "claude") {
      const data = JSON.parse(result.stdout);
      if (data.is_error || data.api_error_status)
        return {
          ok: false,
          reason: data.result || "Provider error",
          capacity: data.api_error_status === 429,
        };
      const usage = data.usage || {};
      const keys = [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ];
      const totalTokens = keys.every((k) => Number.isFinite(usage[k]))
        ? keys.reduce((s, k) => s + usage[k], 0)
        : null;
      const answer = data.structured_output || JSON.parse(data.result);
      return {
        ok: true,
        answer,
        usage,
        totalTokens,
        apiEquivalentUsd: data.total_cost_usd ?? null,
        actualModels: Object.keys(data.modelUsage || {}),
        unexpectedToolUse: !!data.permission_denials?.length,
      };
    }
    const events = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const completion = events.findLast((e) => e.type === "turn.completed");
    if (!completion) return { ok: false, reason: "No completed Codex turn" };
    const usage = completion.usage || {};
    // Codex input_tokens includes cached_input_tokens; do not count cache twice.
    const totalTokens =
      Number.isFinite(usage.input_tokens) &&
      Number.isFinite(usage.output_tokens)
        ? usage.input_tokens + usage.output_tokens
        : null;
    const unexpectedToolUse = events.some(
      (e) => e.item && !["agent_message", "reasoning"].includes(e.item.type),
    );
    return {
      ok: true,
      answer: JSON.parse(outputText),
      usage,
      totalTokens,
      apiEquivalentUsd: null,
      actualModels: [],
      unexpectedToolUse,
    };
  } catch (err) {
    return { ok: false, reason: "Invalid CLI result: " + err.message };
  }
}
