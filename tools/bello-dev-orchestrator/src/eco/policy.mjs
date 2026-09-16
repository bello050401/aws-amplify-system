import crypto from "node:crypto";
import { DEFAULT_ROUTING, validateRouting } from "./taskRouting.mjs";
function canonical(value) {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
}
export const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(canonical(value)),
    )
    .digest("hex");
export const MODES = [
  "claude_only",
  "codex_only",
  "cooperative_eco",
  "fully_automatic",
];
export const DEFAULT_ECO = Object.freeze({
  enabled: false,
  mode: "claude_only",
  gptBrowserQa: true,
  claudeImplementation: true,
  modelAutoRouting: true,
  contextCache: true,
  rereadPrevention: true,
  maxRepairLoops: 3,
  stagingAutoDeploy: true,
  productionApproval: true,
  maxElapsedSeconds: 3600,
  maxTokens: 100000,
  maxCostUsd: 5,
  communicationRetries: 2,
  artifactRetries: 2,
  retentionDays: 30,
  qaUrl: "",
  allowedDomains: [],
  testAccount: "",
  modelPolicy: { economy: null, standard: null, advanced: null },
  taskRouting: DEFAULT_ROUTING,
});
export function validateEco(input, capabilities = {}) {
  if (!input || Object.keys(input).some((k) => !(k in DEFAULT_ECO)))
    throw Error("Unknown configuration field");
  const c = { ...structuredClone(DEFAULT_ECO), ...input };
  const warnings = [];
  c.taskRouting = validateRouting(c.taskRouting);
  if (!MODES.includes(c.mode)) throw Error("Unknown development mode");
  for (const k of [
    "enabled",
    "gptBrowserQa",
    "claudeImplementation",
    "modelAutoRouting",
    "contextCache",
    "rereadPrevention",
    "stagingAutoDeploy",
  ])
    if (typeof c[k] !== "boolean") throw Error("Invalid " + k);
  if (c.productionApproval !== true)
    throw Error("Production approval cannot be disabled");
  for (const [k, min, max] of [
    ["maxRepairLoops", 0, 10],
    ["communicationRetries", 0, 10],
    ["artifactRetries", 0, 10],
    ["maxElapsedSeconds", 1, 86400],
    ["maxTokens", 1, 10000000],
    ["retentionDays", 1, 365],
  ])
    if (!Number.isInteger(c[k]) || c[k] < min || c[k] > max)
      throw Error("Invalid " + k);
  if (!Number.isFinite(c.maxCostUsd) || c.maxCostUsd <= 0)
    throw Error("Invalid cost limit");
  if (
    typeof c.testAccount !== "string" ||
    c.testAccount.length > 100 ||
    /(password|token|secret|@)/i.test(c.testAccount)
  )
    throw Error("Use an account type, never credentials");
  if (!c.contextCache) {
    c.rereadPrevention = false;
    warnings.push("キャッシュOFFのため再読込抑制は無効です");
  }
  if (
    !Array.isArray(c.allowedDomains) ||
    c.allowedDomains.some((d) => !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(d))
  )
    throw Error("Invalid allowed domains");
  if (c.qaUrl) {
    const u = new URL(c.qaUrl);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !c.allowedDomains.includes(u.hostname)
    )
      throw Error("QA URL must be an allowed HTTPS URL without credentials");
  }
  const missing = [];
  if (c.mode === "cooperative_eco" || c.mode === "fully_automatic") {
    if (c.gptBrowserQa && !capabilities.browserQa?.connected)
      missing.push("GPTブラウザQAの常駐接続が未設定");
    if (c.claudeImplementation && !capabilities.claude?.connected)
      missing.push("Claude実行接続の認証・能力が未確認");
    if (c.stagingAutoDeploy && !capabilities.staging?.connected)
      missing.push("対象revisionを照合できるstaging接続が未設定");
    if (!c.qaUrl) missing.push("QA URLが未設定");
    if (!c.modelPolicy?.standard)
      missing.push("利用可能なモデル階層マッピングが未設定");
  }
  for (const tier of ["economy", "standard", "advanced"]) {
    const m = c.modelPolicy?.[tier];
    if (
      m &&
      (!["claude", "codex"].includes(m.provider) ||
        typeof m.model !== "string" ||
        !m.model.trim() ||
        !Array.isArray(m.capabilities))
    )
      throw Error("Invalid model mapping " + tier);
  }
  if (c.enabled && missing.length) throw Error(missing.join(" / "));
  return { config: c, warnings, missing };
}
export function routeModel(
  config,
  { phase, logicalFailures = 0, capacityLimited = false },
) {
  if (capacityLimited)
    return {
      waiting: "WAITING_CAPACITY",
      reason: "利用枠不足。昇格で回避しません",
    };
  const tiers = ["economy", "standard", "advanced"];
  let index = ["format", "dedupe", "record", "local_ui"].includes(phase)
    ? 0
    : phase === "architecture"
      ? 2
      : 1;
  if (config.modelAutoRouting)
    index = Math.min(2, index + Math.min(logicalFailures, 1));
  else index = 1;
  const selected = config.modelPolicy[tiers[index]];
  const required = phase.startsWith("qa") ? "browser" : "code";
  if (!selected?.capabilities.includes(required))
    return {
      waiting: "HUMAN_REVIEW",
      reason: "モデルの必要能力が未確認",
      tier: tiers[index],
    };
  return {
    ...selected,
    tier: tiers[index],
    reason: logicalFailures
      ? "論理失敗による一段昇格"
      : "作業内容に適合する開始階層",
  };
}
export function retryDelay(attempt, random = Math.random) {
  return Math.min(30000, 1000 * 2 ** attempt) * (0.75 + random() * 0.5);
}
