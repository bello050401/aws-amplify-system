/**
 * 審査エンジン共通のエラーと分類 (指示書 §7-4)。
 *
 * 「一時的に審査できない」と「設定を直さないと二度と審査できない」を区別する。
 * 前者はバックオフして待つ、後者はユーザー TODO を出して待つ。
 */

export const REVIEW_FAILURE = Object.freeze({
  /** 課金・利用上限に到達。時間をおけば直るが、待つ判断は人に委ねる。 */
  USAGE_LIMIT: "usage_limit",
  /** ログインが切れた。人がログインし直すまで直らない。 */
  AUTH_EXPIRED: "auth_expired",
  /** 選んだ審査方式に必要な設定が無い (例: OpenAI を選んだのにキーが無い)。 */
  NOT_CONFIGURED: "not_configured",
  /** 一時的な失敗。バックオフして再試行する。 */
  TRANSIENT: "transient",
  /** 審査そのものが失敗した (出力がスキーマに合わない等)。 */
  REVIEW_FAILED: "review_failed",
});

/** ユーザーの操作が要る = 自動リトライでは直らない失敗。 */
export const NEEDS_USER_ACTION = Object.freeze([
  REVIEW_FAILURE.USAGE_LIMIT,
  REVIEW_FAILURE.AUTH_EXPIRED,
  REVIEW_FAILURE.NOT_CONFIGURED,
]);

export class ReviewUnavailableError extends Error {
  constructor(message, reason = REVIEW_FAILURE.TRANSIENT) {
    super(message);
    this.name = "ReviewUnavailableError";
    this.reason = reason;
  }
}

const USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /利用(?:上限|制限)/,
  /quota/i,
  /insufficient[_ ]quota/i,
  /too many requests/i,
  /overloaded/i,
  /429/,
  /max[_ ]budget/i,
  /budget (?:exceeded|limit)/i,
];

const AUTH_PATTERNS = [
  /\/login/,
  /not logged in/i,
  /log in to/i,
  /authentication[_ ]error/i,
  /unauthorized/i,
  /invalid api key/i,
  /credentials?[^a-z]{0,3}(?:expired|invalid)/i,
  /401/,
  /403/,
  /oauth token (?:has )?expired/i,
  /セッションの有効期限/,
];

/**
 * Claude CLI / HTTP の出力文字列から失敗の種類を推定する。
 * 判定できないものは TRANSIENT（＝バックオフして再試行）にする。
 * 誤って AUTH と判定して人を呼ぶより、待って再試行する方が害が小さい。
 */
export function classifyFailureText(text) {
  const s = String(text ?? "");
  if (!s) return REVIEW_FAILURE.TRANSIENT;
  // 利用上限を先に見る。上限メッセージに 403 等が混ざることがあるため。
  if (USAGE_LIMIT_PATTERNS.some((re) => re.test(s))) return REVIEW_FAILURE.USAGE_LIMIT;
  if (AUTH_PATTERNS.some((re) => re.test(s))) return REVIEW_FAILURE.AUTH_EXPIRED;
  return REVIEW_FAILURE.TRANSIENT;
}

/** 失敗の種類ごとの、ユーザー向けの説明と手順。 */
export function describeFailure(reason, { provider = "claude" } = {}) {
  switch (reason) {
    case REVIEW_FAILURE.USAGE_LIMIT:
      return {
        category: "approval",
        title: "審査用 Claude の利用上限に達しました",
        reason:
          "審査担当の Claude Code セッションが利用上限に達したため、完了報告を審査できませんでした。" +
          "開発タスクの状態は保存してあります。上限が回復すれば、そのまま審査に進みます。",
        steps: [
          "しばらく待つ（上限は一定時間で回復します）",
          "急ぐ場合は、ダッシュボードの設定で審査方式を「手動審査」に切り替えて自分で判定する",
          "回復したら bello.ps1 status で審査待ちのタスクが進むことを確認する",
        ],
        completionCondition: "審査待ちのタスクが進んだこと、または手動審査で判定したこと",
        canUseIPhone: true,
        estimatedMinutes: 5,
        priority: "normal",
      };
    case REVIEW_FAILURE.AUTH_EXPIRED:
      return {
        category: "auth",
        title: "Claude Code のログインが切れています",
        reason:
          "審査担当の Claude Code セッションが認証エラーになりました。ログインし直すまで審査も実装も進みません。" +
          "タスクの状態は保存してあります。",
        steps: [
          'PowerShell で: cd "C:\\Users\\win\\Documents\\GitHub\\aws-amplify-system"',
          "claude と入力して起動し、/login を実行してブラウザでサインインする",
          "サインイン後、そのセッションは閉じてよい",
          "bello.ps1 status で審査待ちのタスクが進むことを確認する",
        ],
        completionCondition: "claude で /login を完了し、審査待ちのタスクが進んだこと",
        canUseIPhone: false,
        estimatedMinutes: 5,
        priority: "urgent",
      };
    case REVIEW_FAILURE.NOT_CONFIGURED:
      return {
        category: "specification_decision",
        title: `審査方式「${provider}」に必要な設定がありません`,
        reason:
          `選択されている審査方式 (${provider}) を実行できませんでした。` +
          "設定を用意するか、ダッシュボードで別の審査方式へ切り替えてください。",
        steps: [
          "ダッシュボードの「設定」画面を開く",
          "審査方式を「Claude審査（追加課金なし）」または「手動審査」に変更する",
          "変更後、審査待ちのタスクは自動で進みます",
        ],
        completionCondition: "審査方式を変更したこと、または必要な設定を用意したこと",
        answerFormat: "text",
        answerRequired: true,
        canUseIPhone: true,
        estimatedMinutes: 5,
        priority: "normal",
      };
    default:
      return {
        category: "approval",
        title: "審査が繰り返し失敗しています",
        reason: "自動審査が既定回数を超えて失敗しました。タスクの状態は保存してあります。",
        steps: [
          "ダッシュボードのタスク詳細で完了報告とログを確認する",
          "手動審査に切り替えて判定するか、タスクを取り消す",
        ],
        completionCondition: "手動で判定したこと、またはタスクを取り消したこと",
        canUseIPhone: true,
        estimatedMinutes: 10,
        priority: "normal",
      };
  }
}
