import type { MercariErrorCode } from "./errors";

/**
 * 「接続確認の結果を受けて、入力された接続設定を保存してよいか」の判断だけを
 * 取り出した純関数(夜間統合指示書 2026-09-01 §3.4)。
 *
 * ## なぜ切り出すか
 *
 * この判断はapp/actions/mercariSecret.tsのServer Action内にあったが、
 * Server Actionは`next/cache`・Amplifyの認証・AWS Secrets Managerへ
 * 依存するため、分岐の網羅テストが書けない。判断そのものは入力
 * (検証成否・エラー分類・既存設定の状態)だけで決まる純粋な規則なので、
 * ここへ独立させて全分岐をscripts/verify-mercari.tsで固定する。
 *
 * ## 規則
 *
 * Mercariは **未登録の送信元IPからのリクエストに対し、認証を評価する前に
 * HTTP 404を返す**(公式FAQ、および2026-09-01の実測)。したがって
 * 「接続確認に成功した場合のみ保存する」という以前の設計では、IPが
 * 未登録である限り **正しいTOKENですら保存できない** —— これが実際に
 * 起きていた保存デッドロックである。
 *
 * そこで失敗の種類を3つに分ける。
 *
 *   1. TOKENが拒否された(401 AUTH_FAILED / 400 BAD_REQUEST)
 *      → 保存しない。保存しても動かず、「設定済み」表示が嘘になる。
 *   2. TOKENの正否を判定できなかった(404 IP未登録・ネットワーク・
 *      タイムアウト・レート制限・想定外応答 等)
 *      → 既存の**検証済み**設定があるなら上書きしない(§92の既存意図)。
 *        無いなら「設定済み・未検証」として保存する(デッドロック解消)。
 *   3. 成功 → 検証済みとして保存する。
 */

export type MercariSaveDecision =
  | { save: true; verified: true; status: "CONNECTED" }
  | { save: true; verified: false; status: "SAVED_UNVERIFIED" }
  | { save: false; reason: "TOKEN_REJECTED" }
  | { save: false; reason: "PRESERVE_VERIFIED_EXISTING" };

/**
 * TOKEN自体がMercariに拒否されたと言い切れる分類。
 *
 * 400を含めるのは公式ドキュメントFAQ(Error)の記載による: 400の原因として
 * 「Authorizationヘッダーの指定ミス」「アクセス先の環境とアクセストークンの
 * 組み合わせが間違っている(Sandbox用トークンで本番環境へアクセス、逆も同様)」
 * 「アクセストークンを発行したアカウントが削除された」が挙げられており、
 * いずれも入力されたTOKEN/環境の組み合わせを直さない限り解決しない。
 */
export function isMercariTokenRejected(code: MercariErrorCode | undefined): boolean {
  return code === "AUTH_FAILED" || code === "BAD_REQUEST";
}

/** 時間をおけば結果が変わり得る分類(利用者へ再試行を促してよいもの)。 */
export function isMercariRetryableForUser(code: MercariErrorCode | undefined): boolean {
  return code === "NETWORK_ERROR" || code === "TIMEOUT" || code === "RATE_LIMITED" || code === "UNKNOWN_REMOTE_ERROR";
}

export function decideMercariSave(input: {
  /** 接続確認が成功したか。 */
  validationOk: boolean;
  /** 失敗時の通信層の分類。 */
  code: MercariErrorCode | undefined;
  /** 既に「接続確認済み」の設定がSecretに保存されているか。 */
  hasVerifiedExisting: boolean;
}): MercariSaveDecision {
  if (input.validationOk) return { save: true, verified: true, status: "CONNECTED" };
  if (isMercariTokenRejected(input.code)) return { save: false, reason: "TOKEN_REJECTED" };
  if (input.hasVerifiedExisting) return { save: false, reason: "PRESERVE_VERIFIED_EXISTING" };
  return { save: true, verified: false, status: "SAVED_UNVERIFIED" };
}
