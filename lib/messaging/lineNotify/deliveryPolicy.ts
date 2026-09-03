/**
 * 2026-09-03 指示書 §8: 通知の再試行と打ち切りの判断。
 *
 * ── なぜ純粋関数として切り出すか ────────────────────────────────
 *
 * §8末尾が「同一問い合わせに対し無限に通知し続けない」を要求している。
 * ここを間違えると、**同じ問い合わせのLINEが延々と鳴り続ける**という、
 * 実害が大きくかつ本番でしか気づけない壊れ方をする。AWSにもLINEにも
 * 触らない形にして、全分岐を scripts/verify-line-notify.ts で固定する。
 */

export type DeliveryStatus = "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "DEAD_LETTER";

/**
 * 最大試行回数。
 *
 * 3回にしたのは、失敗の大半が一時的なもの(ネットワーク・レート制限)で
 * 2回目までにほぼ吸収でき、それを超えて直らないものは設定の問題である
 * ことが多いため。無限に粘るより、早めに DEAD_LETTER にして画面へ
 * 出したほうが人が気づける。
 */
export const MAX_DELIVERY_ATTEMPTS = 3;

export interface DeliveryDecision {
  status: DeliveryStatus;
  /** もう一度送ってよいか。false なら人が直すまで止める。 */
  shouldRetry: boolean;
  /** 画面に出す理由。なぜ止まっているのかが分からない状態を作らない。 */
  reason: string;
}

/**
 * 送信が失敗したときの次の状態。
 *
 * 【retryable=false を試行回数より先に見る】認証エラーや宛先不正は、
 * 何回送り直しても同じ結果になる。回数を使い切るまで粘ると、その間
 * 「まだ再試行中」と表示され続けて、人が直すべき問題に気づくのが遅れる。
 */
export function decideAfterFailure(params: {
  /** 今回の試行を含めた試行回数。 */
  attemptCount: number;
  /** 再試行して直る見込みがあるか(LineNotifyError.retryable)。 */
  retryable: boolean;
  /** 失敗理由(そのまま画面へ出す)。 */
  errorMessage: string;
}): DeliveryDecision {
  if (!params.retryable) {
    return {
      status: "DEAD_LETTER",
      shouldRetry: false,
      reason: `再試行しても解決しない種類の失敗のため停止しました: ${params.errorMessage}`,
    };
  }
  if (params.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    return {
      status: "DEAD_LETTER",
      shouldRetry: false,
      reason: `${MAX_DELIVERY_ATTEMPTS}回試行しても送信できなかったため停止しました: ${params.errorMessage}`,
    };
  }
  return {
    status: "FAILED",
    shouldRetry: true,
    reason: `送信に失敗しました(${params.attemptCount}/${MAX_DELIVERY_ATTEMPTS}回目)。再試行します: ${params.errorMessage}`,
  };
}

/**
 * 既存の通知レコードに対して、いま送ってよいか。
 *
 * 【SENT を再送しない】§10「同じWebhookが複数回届いてもLINE通知が
 * 重複しないこと」。Webhookの再送・画面からの再実行・リトライが
 * 同じ dedupeKey へ来ても、一度送れていれば二度と送らない。
 *
 * 【PROCESSING を追い越さない】同時に2つの処理が走ったとき、両方が
 * 「まだ送っていない」と判断して2通ずつ送る事故を防ぐ。
 */
export function canSend(existing: { status: DeliveryStatus; attemptCount: number } | null): DeliveryDecision {
  if (!existing) return { status: "PENDING", shouldRetry: true, reason: "新規の通知です。" };
  if (existing.status === "SENT") {
    return { status: "SENT", shouldRetry: false, reason: "この問い合わせは既に通知済みです。重複して送りません。" };
  }
  if (existing.status === "PROCESSING") {
    return { status: "PROCESSING", shouldRetry: false, reason: "別の処理が送信中です。重複して送りません。" };
  }
  if (existing.status === "DEAD_LETTER") {
    return {
      status: "DEAD_LETTER",
      shouldRetry: false,
      reason: "この通知は停止済みです。原因を解消してから手動で再送してください。",
    };
  }
  if (existing.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    return {
      status: "DEAD_LETTER",
      shouldRetry: false,
      reason: `既に${MAX_DELIVERY_ATTEMPTS}回試行済みのため送りません。`,
    };
  }
  return { status: existing.status, shouldRetry: true, reason: "再試行します。" };
}

/**
 * 重複判定キー。§10 の「チャネルの一意なmessage ID」を第一優先にする。
 *
 * conversationId ではなく **sourceMessageId まで含める**。同じ会話に
 * 2通目の問い合わせが来たら、それは別の通知として送るべきだから ——
 * 会話単位にすると、追加の質問が来ても二度と通知されなくなる。
 */
export function buildDedupeKey(params: { channel: string; conversationId: string; sourceMessageId: string }): string {
  return `${params.channel}:${params.conversationId}:${params.sourceMessageId}`;
}
