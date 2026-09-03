/**
 * 設定の読み込みと検証 (指示書 §13-1)。
 *
 * 不正な設定では「なんとなく既定値で動く」ことをしない。安全に起動失敗させるか、
 * 診断モードへ入れるよう、検証結果を errors として返す。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, "..");
export const DEFAULT_CONFIG_PATH = path.join(PACKAGE_ROOT, "bello-orchestrator.config.json");

/** LOCALAPPDATA が無い実行文脈 (サービス等) でも壊れないようにする。 */
function localAppData() {
  const fromEnv = process.env.LOCALAPPDATA;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  const home = os.homedir();
  if (home) return path.join(home, "AppData", "Local");
  return path.join(PACKAGE_ROOT, ".localdata");
}

const DEFAULTS = {
  repoPath: "",
  dataRoot: "",
  claude: {
    executable: "",
    model: "sonnet",
    permissionMode: "acceptEdits",
    permissionPrompts: "none",
    maxBudgetUsd: 5,
    timeoutSeconds: 3600,
    idleTimeoutSeconds: 900,
    extraArgs: [],
  },
  review: {
    provider: "openai",
    model: "",
    maxRevisions: 3,
    requestTimeoutSeconds: 120,
    maxRetries: 4,
    baseBackoffSeconds: 5,
    maxBackoffSeconds: 300,
    maxDiffChars: 60000,
    minConfidenceToAccept: 0.5,
  },
  queue: {
    maxAttempts: 3,
    retryBaseSeconds: 30,
    retryMaxSeconds: 1800,
    heartbeatWarnSeconds: 900,
    pollIntervalSeconds: 5,
  },
  intake: {
    maxFileBytes: 26214400,
    stableChecks: 3,
    stableIntervalMs: 1500,
    pollIntervalSeconds: 10,
  },
  dashboard: {
    enabled: true,
    host: "127.0.0.1",
    port: 4319,
    lanAccess: false,
    lanAccessTokenEnvVar: "BELLO_DASHBOARD_TOKEN",
  },
  logging: { level: "info", retentionDays: 30, maxFileBytes: 5242880, maxFiles: 10 },
  timezone: "Asia/Tokyo",
  git: { autoCommit: true, allowPush: false, protectedBranches: ["main", "master", "production"] },
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith("$")) continue; // $comment 等のメタキーは無視
    if (isPlainObject(value) && isPlainObject(base?.[key])) out[key] = deepMerge(base[key], value);
    else out[key] = value;
  }
  return out;
}

const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
const PERMISSION_PROMPTS = ["host", "none"];
const LOG_LEVELS = ["debug", "info", "warn", "error"];

/**
 * 設定を検証する。返り値の errors が空でなければ起動してはいけない。
 * warnings は起動を止めないが必ず表示する。
 */
export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];

  if (!cfg.repoPath || typeof cfg.repoPath !== "string") {
    errors.push("repoPath が設定されていません。対象リポジトリの絶対パスを指定してください。");
  } else if (!fs.existsSync(cfg.repoPath)) {
    errors.push(`repoPath が存在しません: ${cfg.repoPath}`);
  } else if (!fs.existsSync(path.join(cfg.repoPath, ".git"))) {
    warnings.push(`repoPath が git 作業ツリーに見えません: ${cfg.repoPath}`);
  }

  if (!PERMISSION_MODES.includes(cfg.claude.permissionMode)) {
    errors.push(
      `claude.permissionMode が不正です: ${cfg.claude.permissionMode}. 使用可能: ${PERMISSION_MODES.join(", ")}`,
    );
  }
  if (cfg.claude.permissionMode === "bypassPermissions") {
    warnings.push(
      "claude.permissionMode=bypassPermissions は全権限チェックを無効にします。指示書 §12 の安全境界に反するため、通常は acceptEdits を使ってください。",
    );
  }
  if (!PERMISSION_PROMPTS.includes(cfg.claude.permissionPrompts)) {
    errors.push(`claude.permissionPrompts は ${PERMISSION_PROMPTS.join(" / ")} のいずれかです。`);
  }
  for (const [key, min] of [
    ["timeoutSeconds", 60],
    ["idleTimeoutSeconds", 60],
  ]) {
    if (!Number.isFinite(cfg.claude[key]) || cfg.claude[key] < min) {
      errors.push(`claude.${key} は ${min} 以上の数値である必要があります。`);
    }
  }
  if (cfg.claude.idleTimeoutSeconds > cfg.claude.timeoutSeconds) {
    warnings.push("claude.idleTimeoutSeconds が timeoutSeconds より大きいため、無出力判定は効きません。");
  }
  if (!Array.isArray(cfg.claude.extraArgs)) errors.push("claude.extraArgs は配列である必要があります。");

  if (!Number.isInteger(cfg.review.maxRevisions) || cfg.review.maxRevisions < 1) {
    errors.push("review.maxRevisions は 1 以上の整数である必要があります (無限修正ループ防止)。");
  }
  if (cfg.review.maxRevisions > 10) {
    warnings.push("review.maxRevisions が大きすぎます。指示書 §7-4 の推奨は 3 です。");
  }
  if (!Number.isInteger(cfg.queue.maxAttempts) || cfg.queue.maxAttempts < 1) {
    errors.push("queue.maxAttempts は 1 以上の整数である必要があります。");
  }
  if (!Number.isInteger(cfg.intake.maxFileBytes) || cfg.intake.maxFileBytes < 1024) {
    errors.push("intake.maxFileBytes は 1024 以上の整数である必要があります。");
  }
  if (!Number.isInteger(cfg.intake.stableChecks) || cfg.intake.stableChecks < 2) {
    errors.push("intake.stableChecks は 2 以上である必要があります (書き込み途中のファイルを掴まないため)。");
  }

  const port = cfg.dashboard.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`dashboard.port が不正です: ${port}`);
  }
  if (cfg.dashboard.lanAccess) {
    if (cfg.dashboard.host === "127.0.0.1" || cfg.dashboard.host === "localhost") {
      errors.push("dashboard.lanAccess を有効にするなら host も 0.0.0.0 等へ変更してください。");
    }
    const tokenVar = cfg.dashboard.lanAccessTokenEnvVar;
    if (!tokenVar || !process.env[tokenVar]) {
      errors.push(
        `dashboard.lanAccess=true ですが認証トークン環境変数 ${tokenVar || "(未設定)"} がありません。無認証で LAN 公開はしません。`,
      );
    }
  }
  if (!LOG_LEVELS.includes(cfg.logging.level)) {
    errors.push(`logging.level は ${LOG_LEVELS.join(" / ")} のいずれかです。`);
  }

  return { errors, warnings };
}

/** dataRoot 配下の実行時ディレクトリ構成。すべて Git 管理外。 */
export function derivePaths(cfg) {
  const root = cfg.dataRoot && cfg.dataRoot.trim()
    ? path.resolve(cfg.dataRoot)
    : path.join(localAppData(), "BELLO", "dev-orchestrator");
  return {
    dataRoot: root,
    dbFile: path.join(root, "orchestrator.db"),
    logDir: path.join(root, "logs"),
    stateDir: path.join(root, "state"),
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    errorDir: path.join(root, "error"),
    uploadsDir: path.join(root, "uploads"),
    evidenceDir: path.join(root, "evidence"),
    runsDir: path.join(root, "runs"),
    pidFile: path.join(root, "state", "orchestrator.pid"),
    stopFlag: path.join(root, "state", "stop.flag"),
    crashLoopFlag: path.join(root, "state", "crashloop.flag"),
  };
}

export function ensureDirs(paths) {
  for (const key of [
    "dataRoot",
    "logDir",
    "stateDir",
    "inboxDir",
    "processedDir",
    "errorDir",
    "uploadsDir",
    "evidenceDir",
    "runsDir",
  ]) {
    fs.mkdirSync(paths[key], { recursive: true });
  }
}

/**
 * 設定を読み込む。ファイルが壊れている場合も例外を投げず、errors に入れて返す。
 * 呼び出し側 (cli.mjs) が診断モードを選べるようにするため。
 */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const result = { configPath, config: null, paths: null, errors: [], warnings: [] };

  let raw = null;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    result.errors.push(`設定ファイルを読めません (${configPath}): ${err.message}`);
    return result;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.errors.push(`設定ファイルが JSON として不正です (${configPath}): ${err.message}`);
    return result;
  }

  const cfg = deepMerge(DEFAULTS, parsed);
  if (!cfg.repoPath) cfg.repoPath = path.resolve(PACKAGE_ROOT, "..", "..");

  const { errors, warnings } = validateConfig(cfg);
  result.config = cfg;
  result.paths = derivePaths(cfg);
  result.errors = errors;
  result.warnings = warnings;
  return result;
}
