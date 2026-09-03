/**
 * 秘密情報の除去 (指示書 §13-2)。
 *
 * ログ、監査ログ、完了報告、OpenAI へ送る本文、ダッシュボード API 応答は
 * すべてここを通す。除去は「値を見つけたら消す」方式と「既知の変数名の値を
 * 消す」方式の両方を持つ。片方だけでは漏れるため。
 */

/** 実行時に判明した秘密値そのもの (APIキー等)。起動時に登録する。 */
const literalSecrets = new Set();

const SECRET_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "BASE_CLIENT_SECRET",
  "ZAICO_API_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "BELLO_DASHBOARD_TOKEN",
];

/** 環境変数に実在する秘密値を除去対象へ登録する。値自体は保存も出力もしない。 */
export function registerEnvSecrets(env = process.env) {
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    // 3 文字以下は誤爆 (例えば "1") の方が害が大きいので登録しない。
    if (typeof value === "string" && value.length > 3) literalSecrets.add(value);
  }
}

export function registerSecret(value) {
  if (typeof value === "string" && value.length > 3) literalSecrets.add(value);
}

/** テスト用。登録済み秘密をすべて忘れる。 */
export function clearRegisteredSecrets() {
  literalSecrets.clear();
}

const PATTERNS = [
  // Authorization ヘッダ / Bearer トークン
  [/\b(Authorization\s*[:=]\s*)(Bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, "$1$2[REDACTED]"],
  // OpenAI / Anthropic 形式のキー
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]"],
  // AWS アクセスキー ID とシークレット
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY_ID]"],
  [/\baws_secret_access_key\s*=\s*\S+/gi, "aws_secret_access_key=[REDACTED]"],
  // GitHub トークン
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED_GITHUB_TOKEN]"],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
  // Cookie / Set-Cookie ヘッダ
  [/\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]"],
  // 環境変数風の代入 (KEY=... / TOKEN=... / SECRET=... / PASSWORD=...)
  [
    /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'&,;]{4,})["']?/gi,
    '$1=[REDACTED]',
  ],
  // URL の中のクエリ秘密 (?token=... &key=...)
  [/([?&](?:token|key|secret|password|sig|signature|access_token)=)[^&\s]+/gi, "$1[REDACTED]"],
];

/**
 * 文字列から秘密を除去する。
 * 非文字列はそのまま返す (呼び出し側の型を壊さないため)。
 */
export function redactText(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;

  // 実値の除去を先に行う。パターンで形を崩される前に消す必要がある。
  for (const secret of literalSecrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * 任意の値を再帰的に除去する。オブジェクトのキー名が秘密的な場合は値ごと落とす。
 * 循環参照は "[Circular]" にする。
 */
export function redactValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    // 秘密は文字列でしか運ばれない。真偽値や数値まで落とすと
    // apiKeyConfigured: false のような「設定されているか」の情報まで消えて
    // 診断画面が役に立たなくなる。
    const secretish = /(api[_-]?key|secret|token|password|passwd|credential|authorization|cookie)/i.test(key);
    if (secretish && typeof v === "string") out[key] = "[REDACTED]";
    else out[key] = redactValue(v, seen);
  }
  return out;
}

/**
 * コマンドラインを記録用に安全化する (指示書 §6-5 commandRedacted)。
 * 引数配列を受け取り、秘密を除去した 1 行にする。
 */
export function redactCommand(file, args = []) {
  return redactText([file, ...args].join(" "));
}
