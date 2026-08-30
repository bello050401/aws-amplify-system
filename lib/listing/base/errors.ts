/**
 * BELLO統合業務OS 第二次完全完遂指示(2026-08-30) §4: BASE
 * (thebase.in)の商品作成/編集API呼び出し時のエラー分類。
 * lib/listing/mercari/errors.tsと同じ設計方針(ユーザー向け日本語
 * メッセージと技術的詳細を分離)。
 */
export type BaseListingErrorCode = "CONFIG_REQUIRED" | "NOT_CONNECTED" | "AUTH_FAILED" | "RATE_LIMITED" | "REMOTE_VALIDATION_ERROR" | "NETWORK_ERROR" | "UNKNOWN_REMOTE_ERROR";

export const BASE_LISTING_ERROR_LABEL: Record<BaseListingErrorCode, string> = {
  CONFIG_REQUIRED: "BASE連携の設定が不足しています。",
  NOT_CONNECTED: "BASEに接続されていません。設定画面から接続してください。",
  AUTH_FAILED: "BASE APIの認証に失敗しました（接続が切れている可能性があります）。",
  RATE_LIMITED: "BASE APIのレート制限に達しました。しばらく待ってから再試行してください。",
  REMOTE_VALIDATION_ERROR: "BASE APIがリクエストを拒否しました。入力内容を確認してください。",
  NETWORK_ERROR: "BASE APIへの接続に失敗しました。",
  UNKNOWN_REMOTE_ERROR: "BASE APIで予期しないエラーが発生しました。",
};

export class BaseListingApiError extends Error {
  code: BaseListingErrorCode;
  causeMessage: string;
  constructor(code: BaseListingErrorCode, causeMessage: string) {
    super(BASE_LISTING_ERROR_LABEL[code]);
    this.name = "BaseListingApiError";
    this.code = code;
    this.causeMessage = causeMessage;
  }
}

/** BASE APIのレスポンスは`{errors: [...]}`または`{error: "...", error_description: "..."}`の形が確認されている(公式ドキュメント/OAuth2標準準拠)。 */
export function classifyBaseHttpStatus(status: number, bodyText: string): BaseListingApiError {
  if (status === 401) return new BaseListingApiError("AUTH_FAILED", `HTTP 401: ${bodyText.slice(0, 300)}`);
  if (status === 429) return new BaseListingApiError("RATE_LIMITED", `HTTP 429: ${bodyText.slice(0, 300)}`);
  if (status >= 400 && status < 500) return new BaseListingApiError("REMOTE_VALIDATION_ERROR", `HTTP ${status}: ${bodyText.slice(0, 300)}`);
  return new BaseListingApiError("UNKNOWN_REMOTE_ERROR", `HTTP ${status}: ${bodyText.slice(0, 300)}`);
}
