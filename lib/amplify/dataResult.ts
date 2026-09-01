/**
 * Amplify Dataの戻り値を「失敗したら例外」へ変換する。
 *
 * ## なぜこれが要るのか — 実機で起きたこと(2026-09-01)
 *
 * `client.models.X.create()` / `.update()` / `.get()` / `.delete()` は、
 * **認可で拒否されても例外を投げない**。`{ data: null, errors: [...] }`
 * を返すだけである。そのため
 *
 *     const { data } = await client.models.X.create(row);
 *
 * と書くと、書き込みが拒否されても呼び出し側は何事もなく次へ進む。
 *
 * BASE OAuthの接続でこれがそのまま起きた: 認可も、codeとtokenの交換も
 * 成功していたのに、tokenをBaseOAuthTokenへ書く操作がAppSyncに拒否され
 * (画面の門は在庫管理側の `ADMIN`、モデルの認可はFeature側の `Admins`
 * という別体系だった)、テーブルは0行のままなのに管理画面は
 * 「連携が完了しました」と緑色で表示していた。
 *
 * `data`を分解する前にここを通せば、同じ失敗の仕方は再現しない。
 *
 * ## ログに何を出すか
 *
 * errorTypeとmessageだけ。`data`は決して出さない —— このヘルパーは
 * 認証情報を含むモデル(BaseOAuthToken等)からも呼ばれる。
 */

export interface AmplifyDataResult<T> {
  data: T;
  errors?: { message?: string; errorType?: string }[];
}

export class AmplifyDataError extends Error {
  constructor(
    message: string,
    /** 認可拒否か(設定の問題)、それ以外か(一時的な障害の可能性)。 */
    public readonly unauthorized: boolean,
    /** 監査・切り分け用。秘密値は含まない。 */
    public readonly errorTypes: string[],
  ) {
    super(message);
    this.name = "AmplifyDataError";
  }
}

function looksUnauthorized(text: string | undefined): boolean {
  return /unauthorized|not authorized/i.test(text ?? "");
}

/**
 * @param operation ログと切り分けのための短い識別子(例: "BaseOAuthToken.create")。
 * @param messages 利用者へ出す日本語。認可拒否とそれ以外で言うべきことが違う。
 */
export function unwrapDataResult<T>(
  result: AmplifyDataResult<T>,
  operation: string,
  messages: { unauthorized: string; failed: string },
): T {
  const errors = result.errors ?? [];
  if (errors.length === 0) return result.data;

  const unauthorized = errors.some((e) => looksUnauthorized(e.errorType) || looksUnauthorized(e.message));
  const errorTypes = errors.map((e) => e.errorType ?? "unknown");
  console.error("[amplify/data] operation failed", {
    operation,
    errorTypes,
    messages: errors.map((e) => e.message ?? ""),
  });
  throw new AmplifyDataError(unauthorized ? messages.unauthorized : messages.failed, unauthorized, errorTypes);
}
