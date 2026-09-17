// Deterministic planning consumes no model tokens. Classifications are routing
// hints, never authorization to perform a protected operation.
export const WORK_TYPES = {
  instruction_review: {
    label: "指示の確認・不足整理",
    role: "gpt",
    tier: "standard",
    capability: "text",
  },
  specification: {
    label: "仕様・受入条件の作成",
    role: "gpt",
    tier: "standard",
    capability: "text",
  },
  extraction: {
    label: "抽出・分類・定型要約",
    role: "gpt",
    tier: "economy",
    capability: "text",
  },
  log_triage: {
    label: "ログの整理・一次切り分け",
    role: "gpt",
    tier: "economy",
    capability: "text",
  },
  mechanical_edit: {
    label: "限定された文言・定型修正",
    role: "claude",
    tier: "economy",
    capability: "code",
  },
  local_ui: {
    label: "局所的な画面修正",
    role: "claude",
    tier: "standard",
    capability: "code",
  },
  unit_test: {
    label: "単体テスト作成",
    role: "claude",
    tier: "standard",
    capability: "code",
  },
  implementation: {
    label: "通常の機能実装",
    role: "claude",
    tier: "standard",
    capability: "code",
  },
  integration: {
    label: "複数機能・共有処理の修正",
    role: "claude",
    tier: "standard",
    capability: "code",
  },
  architecture: {
    label: "設計・複雑な原因調査",
    role: "gpt",
    tier: "advanced",
    capability: "reasoning",
  },
  security: {
    label: "認証・権限・データ安全性",
    role: "gpt",
    tier: "advanced",
    capability: "reasoning",
  },
  browser_qa: {
    label: "実画面の受入確認",
    role: "gpt",
    tier: "standard",
    capability: "browser",
  },
  verification: {
    label: "テスト・build・HTTP照合",
    role: "host",
    tier: null,
    capability: null,
  },
  delivery: {
    label: "許可済みstagingへの反映",
    role: "host",
    tier: null,
    capability: null,
  },
  record: {
    label: "記録・件数集計・重複照合",
    role: "host",
    tier: null,
    capability: null,
  },
};
export const DEFAULT_ROUTING = Object.freeze({
  enabled: true,
  metric: "measured_usage",
  minSamples: 30,
  maxRegression: 0.02,
  maxEvidenceDays: 30,
  catalog: [],
});

const meaningful = (value) =>
  typeof value === "string"
    ? value.trim().length > 0
    : Array.isArray(value)
      ? value.length > 0 && value.every(meaningful)
      : value && typeof value === "object"
        ? Object.keys(value).length > 0
        : false;
export function inspectInstruction(instruction, spec, acIds = []) {
  const missing = [];
  if (!meaningful(instruction)) missing.push("original_instruction");
  for (const field of [
    "purpose",
    "scope",
    "requirements",
    "acceptanceCriteria",
    "tests",
  ])
    if (!meaningful(spec?.[field])) missing.push(field);
  if (!Array.isArray(spec?.unresolved)) missing.push("unresolved_list");
  else if (spec.unresolved.some((item) => /(?:ユーザー|本人).*(?:判断|選択|承認|操作)|MFA|OAuth|ログイン|認証情報|課金|本番データ|破壊的|(?:IAM|S3|Cognito).*(?:重大|権限拡大)/i.test(String(item))))
    missing.push("human_resolution_required");
  const criteria = Array.isArray(spec?.acceptanceCriteria)
    ? spec.acceptanceCriteria
    : [];
  const ids = criteria.map((ac) => (typeof ac === "string" ? ac : ac.id));
  if (acIds.some((id) => !ids.includes(id)) || new Set(ids).size !== ids.length)
    missing.push("acceptance_coverage");
  return {
    ready: missing.length === 0,
    missing,
    note: "構造と未解決事項を確認。意味の一致はGPTの仕様確認・最終受入確認でも検証します。",
  };
}

export function planWork({
  instruction = "",
  spec = null,
  phase = "implementation",
  files = [],
  risk = "unknown",
  acIds = [],
}) {
  const checked = inspectInstruction(instruction, spec, acIds);
  const phaseTypes = {
    instruction_review: "instruction_review",
    specification: "specification",
    qaInitial: "browser_qa",
    qaVerify: "browser_qa",
    qa_initial: "browser_qa",
    qa_verify: "browser_qa",
    test: "verification",
    deploy: "delivery",
    record: "record",
    format: "extraction",
    dedupe: "record",
  };
  let category = phaseTypes[phase];
  const text = instruction + "\n" + (spec?.purpose || "");
  if (!category) {
    if (
      risk === "high" ||
      files.some((file) =>
        /(^|\/)(auth|permissions?|migrations?|iam|cognito)(\/|\.)/i.test(file),
      )
    )
      category = "security";
    else if (
      /architecture|設計変更|アーキテクチャ|原因不明|race condition|競合状態/i.test(
        text,
      )
    )
      category = "architecture";
    else if (
      files.length > 3 ||
      /integration|複数画面|共有API|DBスキーマ|データモデル/i.test(text)
    )
      category = "integration";
    else if (/unit tests?|単体テスト|テスト追加|テスト作成/i.test(text))
      category = "unit_test";
    else if (/ログ.*(整理|確認|分類)|log (triage|summary)/i.test(text))
      category = "log_triage";
    else if (/抽出|定型要約|分類のみ|extract|summari[sz]e/i.test(text))
      category = "extraction";
    else if (
      risk === "low" &&
      files.length === 1 &&
      /文言|誤字|表記|replace|text.only|marker|マーカー/i.test(text)
    )
      category = "mechanical_edit";
    else if (/画面|CSS|レイアウト|UI\b/i.test(text)) category = "local_ui";
    else category = "implementation";
  }
  const work = WORK_TYPES[category];
  // Implementation stays with the implementation Agent even when its work
  // contains architectural reasoning; do not silently exchange provider roles.
  const role =
    phase === "implementation" &&
    !["extraction", "log_triage"].includes(category)
      ? "claude"
      : work.role;
  return {
    category,
    ...work,
    role,
    phase,
    instructionCheck: checked,
    provisional: !checked.ready,
    risk,
    fileCount: files.length,
  };
}

export function validateRouting(input = {}) {
  const value = { ...structuredClone(DEFAULT_ROUTING), ...input };
  if (
    typeof value.enabled !== "boolean" ||
    !["measured_usage", "api_estimate"].includes(value.metric) ||
    !Number.isInteger(value.minSamples) ||
    value.minSamples < 30 ||
    !Number.isFinite(value.maxRegression) ||
    value.maxRegression < 0 ||
    value.maxRegression > 0.05 ||
    !Number.isInteger(value.maxEvidenceDays) ||
    value.maxEvidenceDays < 1 ||
    value.maxEvidenceDays > 90 ||
    !Array.isArray(value.catalog) ||
    value.catalog.length > 40
  )
    throw Error("Invalid task routing policy");
  const ids = new Set();
  for (const model of value.catalog) {
    const id = model.provider + ":" + model.model;
    if (
      !["claude", "codex"].includes(model.provider) ||
      typeof model.model !== "string" ||
      !model.model.trim() ||
      ids.has(id) ||
      !["economy", "standard", "advanced"].includes(model.tier) ||
      !Array.isArray(model.capabilities) ||
      !model.evaluations ||
      typeof model.evaluations !== "object"
    )
      throw Error("Invalid or duplicate model catalog entry");
    ids.add(id);
  }
  return value;
}

export function verifyEvaluationEvidence(store, model, category, evaluation) {
  if (!/^checkpoint:[1-9][0-9]*$/.test(evaluation?.evidenceId || ""))
    return false;
  const row = store.get(
    "SELECT data FROM checkpoints WHERE id=? AND phase='eco_model_evaluation'",
    [Number(evaluation.evidenceId.split(":")[1])],
  );
  if (!row) return false;
  try {
    const record = JSON.parse(row.data);
    const normalized = (value) =>
      JSON.stringify(
        Object.entries(value)
          .filter(([key]) => key !== "evidenceId")
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    return (
      record.schemaVersion === 1 &&
      record.origin === "host-independent-evaluation" &&
      record.provider === model.provider &&
      record.model === model.model &&
      record.category === category &&
      normalized(record.evaluation) === normalized(evaluation)
    );
  } catch {
    return false;
  }
}

export function selectForWork({
  policy = DEFAULT_ROUTING,
  work,
  baseline,
  logicalFailures = 0,
  capacityLimited = false,
  available = () => false,
  evidenceVerified = () => false,
  now = Date.now(),
  roleProvider,
  autoRouting = true,
}) {
  const config = validateRouting(policy);
  if (capacityLimited)
    return {
      waiting: "WAITING_CAPACITY",
      reason: "利用枠不足をモデル切替で回避しません",
      work,
    };
  if (work.role === "host")
    return { executor: "host", reason: "定型処理はAIを呼び出しません", work };
  const preparing = [
    "instruction_review",
    "specification",
    "qaInitial",
    "qa_initial",
  ].includes(work.phase);
  if (
    !work.instructionCheck.ready &&
    !(
      preparing &&
      !work.instructionCheck.missing.includes("original_instruction")
    )
  )
    return {
      waiting: "HUMAN_REVIEW",
      reason: "実装前に指示・仕様・未解決事項を確認します",
      missing: work.instructionCheck.missing,
      work,
    };
  const fallback = (reason) => ({
    ...baseline,
    work,
    selectionBasis: reason,
    comparison: null,
  });
  if (!config.enabled || !autoRouting)
    return fallback("自動振り分けOFF：既存モデルを維持");
  // High-risk changes and logical failures never experiment with cheaper models.
  if (
    logicalFailures ||
    ["security", "architecture"].includes(work.category) ||
    work.risk !== "low"
  )
    return fallback("安全性・複雑性・再試行を優先：既存の階層方針を維持");
  const provider = roleProvider || (work.role === "gpt" ? "codex" : "claude");
  const candidates = [];
  for (const model of config.catalog) {
    if (
      model.provider !== provider ||
      !model.capabilities.includes(work.capability) ||
      !available(model)
    )
      continue;
    const ev = model.evaluations[work.category];
    if (!evidenceVerified(model, work.category, ev)) continue;
    const age = now - Date.parse(ev?.evaluatedAt);
    if (
      !ev ||
      !ev.evidenceId ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > config.maxEvidenceDays * 86400000 ||
      !Number.isInteger(ev.samples) ||
      ev.samples < config.minSamples ||
      !Number.isFinite(ev.passRate) ||
      ev.passRate < 0.95 ||
      ev.passRate > 1 ||
      !Number.isFinite(ev.baselinePassRate) ||
      ev.baselinePassRate < 0 ||
      ev.baselinePassRate > 1 ||
      ev.passRate < ev.baselinePassRate - config.maxRegression ||
      ev.safetyFailures !== 0 ||
      !Number.isFinite(ev.meanAttempts) ||
      ev.meanAttempts < 1
    )
      continue;
    let score;
    if (config.metric === "measured_usage") {
      if (
        !Number.isFinite(ev.meanUsagePerAttempt) ||
        ev.meanUsagePerAttempt <= 0 ||
        !ev.usageUnit
      )
        continue;
      score = (ev.meanUsagePerAttempt * ev.meanAttempts) / ev.passRate;
    } else {
      const p = model.apiPricing,
        priceAge = now - Date.parse(p?.checkedAt);
      if (
        !p ||
        !Number.isFinite(priceAge) ||
        priceAge < 0 ||
        priceAge > config.maxEvidenceDays * 86400000 ||
        ![
          p.inputPerMillion,
          p.outputPerMillion,
          ev.meanInputTokens,
          ev.meanOutputTokens,
        ].every((n) => Number.isFinite(n) && n >= 0)
      )
        continue;
      score =
        (((p.inputPerMillion * ev.meanInputTokens +
          p.outputPerMillion * ev.meanOutputTokens) /
          1e6) *
          ev.meanAttempts) /
        ev.passRate;
    }
    candidates.push({
      model,
      ev,
      score,
      unit:
        config.metric === "api_estimate"
          ? "API換算USD（請求額ではありません）"
          : ev.usageUnit,
    });
  }
  const base = candidates.find(
    (c) =>
      c.model.provider === baseline?.provider &&
      c.model.model === baseline?.model,
  );
  if (!base)
    return fallback("基準モデルと同じ仕事で比較できる実測データが不足");
  const eligible = candidates.filter(
    (c) =>
      c.unit === base.unit &&
      c.ev.evaluationSet === base.ev.evaluationSet &&
      c.ev.evaluationSet &&
      c.ev.baselineModel === base.model.model &&
      c.ev.baselinePassRate === base.ev.passRate,
  );
  eligible.sort(
    (a, b) => a.score - b.score || a.model.model.localeCompare(b.model.model),
  );
  const winner = eligible[0];
  if (!winner || winner.score >= base.score)
    return fallback("品質条件を満たし、総使用量を減らせる候補がない");
  return {
    provider: winner.model.provider,
    model: winner.model.model,
    tier: winner.model.tier,
    capabilities: winner.model.capabilities,
    reason:
      "同じ仕事内容の評価で品質を確認し、再試行込みの総量が少ないモデルを選択",
    work,
    selectionBasis: "category_evaluation",
    comparison: {
      metric: config.metric,
      unit: winner.unit,
      expectedPerSuccess: winner.score,
      baselinePerSuccess: base.score,
      estimatedReduction: 1 - winner.score / base.score,
      evidenceId: winner.ev.evidenceId,
      evaluationSet: winner.ev.evaluationSet,
      note: "過去の評価に基づく推定。将来の品質・節約を保証しません。",
    },
  };
}
