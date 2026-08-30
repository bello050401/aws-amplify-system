import type { GraphQLErrorItem } from "./types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §29/§90/§95: Mercari
 * Shops APIの失敗を、UI・ログ・接続確認のすべてで一貫して扱うための
 * 分類。以前は「MercariApiError」1種類に全部の失敗(設定不備・認証・
 * ネットワーク・GraphQLバリデーション等)をまとめて詰め込んでいたため、
 * ADMIN向けの接続設定画面で「何が悪いのか」を出し分けられなかった
 * (§90: 「詳細はadmin/log」「AUTH_FAILED CONFIG_REQUIRED RATE_LIMITED
 * REMOTE_VALIDATION_ERROR」のようなカテゴリをuser-facingメッセージと
 * 分離せよという要件)。
 *
 * この`code`はあくまで「UIがどう振る舞うべきか」の分類であって、
 * Mercari側の正確なエラーコード体系そのものではない
 * ([UNVERIFIED] — 実際のMercari GraphQL
 * schemaのエラーextensions.code一覧はこのsandbox環境から確認できて
 * いないため、HTTPステータス・GraphQLエラーメッセージの文字列からの
 * ヒューリスティック分類に留めている。実際の値が確認できた時点で
 * classifyMercariError内の判定をそちらへ合わせて更新すること)。
 */
export type MercariErrorCode =
  | "CONFIG_REQUIRED"
  | "AUTH_FAILED"
  | "IP_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "REMOTE_VALIDATION_ERROR"
  | "NETWORK_ERROR"
  | "UNKNOWN_REMOTE_ERROR";

/** ADMIN向け(接続設定画面)の日本語メッセージ — §90: 「raw stack trace禁止」「user-facing: 一般的な説明」。技術的な詳細(HTTPステータス/GraphQLメッセージ全文)はcauseMessageへ別枠で保持し、必要な場合だけ「詳細」展開に使う。 */
export const MERCARI_ERROR_LABEL: Record<MercariErrorCode, string> = {
  CONFIG_REQUIRED: "設定が不足しています。",
  AUTH_FAILED: "認証に失敗しました（TOKENが無効か期限切れの可能性があります）。",
  IP_NOT_ALLOWED: "アクセス元が許可されていません（IP制限の可能性があります）。",
  RATE_LIMITED: "リクエストが多すぎます。しばらく待って再試行してください。",
  REMOTE_VALIDATION_ERROR: "送信内容にMercari側で受け付けられない項目があります。",
  NETWORK_ERROR: "Mercari Shops APIへ接続できません（ネットワークエラー）。",
  UNKNOWN_REMOTE_ERROR: "不明なエラーが発生しました。",
};

export class MercariApiError extends Error {
  readonly code: MercariErrorCode;
  readonly errors: GraphQLErrorItem[];
  readonly requestId?: string;
  /** 技術的な原因文字列(HTTPステータス・GraphQLメッセージ等) — ログや「詳細」展開にだけ使う。§90: 一般ユーザー向け本文とは分離する。 */
  readonly causeMessage: string;

  constructor(code: MercariErrorCode, causeMessage: string, errors: GraphQLErrorItem[] = [], requestId?: string) {
    super(`${MERCARI_ERROR_LABEL[code]} (${causeMessage})`);
    this.name = "MercariApiError";
    this.code = code;
    this.causeMessage = causeMessage;
    this.errors = errors;
    this.requestId = requestId;
  }
}

/** §29: 429/5xxはリトライ対象 — client.tsのリトライループが判定に使う。CONFIG_REQUIREDのような設定不備はリトライしても直らないため対象外。 */
export function isRetryableMercariErrorCode(code: MercariErrorCode): boolean {
  return code === "RATE_LIMITED" || code === "NETWORK_ERROR" || code === "UNKNOWN_REMOTE_ERROR";
}

/**
 * HTTPステータスコードからの一次分類(client.tsのsingleRequestが
 * response.status確定後すぐ呼ぶ)。IP_NOT_ALLOWEDは403のうち文面から
 * それと分かるものだけを拾う特殊ケースなので、AUTH_FAILEDより先に
 * bodyTextを見て判定する必要がある — この関数自体はステータスのみで
 * 一次分類し、403の詳細な出し分けはclassifyForbiddenErrorへ委ねる。
 */
export function classifyHttpStatus(status: number): MercariErrorCode {
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return "AUTH_FAILED"; // classifyForbiddenErrorがbody次第でIP_NOT_ALLOWEDへ上書きする
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UNKNOWN_REMOTE_ERROR"; // §29のカテゴリ一覧に5xx専用の名前が無いため、リトライ対象という性質だけ揃えてここへ分類
  return "UNKNOWN_REMOTE_ERROR"; // 404等、他のどのカテゴリにも当てはまらない予期しないHTTPステータス
}

/** 403応答のbody文面にIP制限を示す語があればIP_NOT_ALLOWEDへ格上げする。 */
export function classifyForbiddenError(bodyText: string): MercariErrorCode {
  const lower = bodyText.toLowerCase();
  if (lower.includes("ip") && (lower.includes("allow") || lower.includes("block") || lower.includes("restrict") || lower.includes("denied"))) {
    return "IP_NOT_ALLOWED";
  }
  return "AUTH_FAILED";
}

/**
 * HTTP 200で返ってきたGraphQLエラー配列からの分類。Mercari独自の
 * extensions.codeが確認できていないため([UNVERIFIED]、上のファイル
 * コメント参照)、まずextensions.codeの文字列に既知の語が含まれるかを
 * 見て、無ければメッセージ文字列のヒューリスティックへフォールバック
 * する。GraphQLエラーはHTTP層としては成功しているため、大半は
 * 「送った内容が受け付けられなかった」バリデーション系 —
 * 判定できない場合の既定値もREMOTE_VALIDATION_ERRORにしている(NETWORK_ERROR
 * やUNKNOWN_REMOTE_ERRORより実態に近いため)。
 */
export function classifyGraphQLErrors(errors: GraphQLErrorItem[]): MercariErrorCode {
  const combined = errors
    .map((e) => `${e.extensions?.code ?? ""} ${e.message}`)
    .join(" ")
    .toLowerCase();
  if (/unauthenticated|unauthorized|invalid.*token|token.*invalid|token.*expired/.test(combined)) return "AUTH_FAILED";
  if (/forbidden|permission/.test(combined)) return "AUTH_FAILED";
  if (/rate.?limit|too many requests/.test(combined)) return "RATE_LIMITED";
  return "REMOTE_VALIDATION_ERROR";
}
