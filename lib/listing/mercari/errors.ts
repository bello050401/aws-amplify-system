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
  | "BAD_REQUEST"
  | "IP_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "REMOTE_VALIDATION_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "UNKNOWN_REMOTE_ERROR";

/** ADMIN向け(接続設定画面)の日本語メッセージ — §90: 「raw stack trace禁止」「user-facing: 一般的な説明」。技術的な詳細(HTTPステータス/GraphQLメッセージ全文)はcauseMessageへ別枠で保持し、必要な場合だけ「詳細」展開に使う。 */
export const MERCARI_ERROR_LABEL: Record<MercariErrorCode, string> = {
  CONFIG_REQUIRED: "設定が不足しています。",
  AUTH_FAILED: "認証に失敗しました（TOKENが無効か期限切れの可能性があります）。",
  // 2026-09-01: Mercari Shops公式ドキュメント本文(api.mercari-shops.com/
  // docs/index.html)を、この端末から**直接HTTP 200で取得**して確認した
  // FAQ(Error)の記載 — 以前のセッションはこのURLへ直接到達できず検索結果の
  // 要約に頼っていたが、実際には到達できる(docs/mercari-connection-
  // evidence-20260901.md に実測ログあり)。そこには「400エラー: JSON構文
  // エラーやクエリ構文エラー時」に加え、原因として「Authorizationヘッダー
  // の指定ミス」「アクセス先の環境とアクセストークンの組み合わせが
  // 間違っている(Sandbox用トークンで本番環境へアクセス、逆も同様)」
  // 「アクセストークンを発行したアカウントが削除された」が明記されている。
  // つまり400は「こちらの送り方・設定の誤り」であり、リトライで直る種類の
  // 失敗ではない — 以前はUNKNOWN_REMOTE_ERROR(=リトライ対象)へ落ちており、
  // 設定ミスのまま無駄に4回リクエストを送っていた。
  BAD_REQUEST: "リクエストがMercari側に受け付けられませんでした（TOKENと環境（sandbox/本番）の組み合わせや、Authorizationヘッダの設定をご確認ください）。",
  // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §4での再調査
  // (WebSearch、2026-08-30時点)で新たに確認: Mercari Shops API公式
  // ドキュメント(api.mercari-shops.com/docs/index.html、この
  // サンドボックスからは直接WebFetchできない対象だが、検索結果の
  // 要約から複数回・一貫して同じ内容を確認できた)には「未登録の
  // IPアドレスからのリクエストは404 NotFoundを返す」「個別の固定IP
  // アドレスを環境(sandbox/production)ごとに事前登録する必要がある
  // （IP範囲指定は不可）」と明記されていた——これはlib/listing/
  // mercari/endpoints.tsの以前の調査(「Mercari→BELLOのWebhook送信元
  // IPの話であり、BELLO→MercariのAPI発信には固定IP不要」という結論)
  // を訂正する新事実であり、実際に報告されたHTTP 404と完全に一致する
  // (403ではなく404である点も公式記述と一致)。詳細:
  // docs/mercari-404-root-cause-20260830.md参照。
  IP_NOT_ALLOWED: "アクセス元のIPアドレスがMercari側に未登録の可能性があります（固定IPアドレスの事前登録が環境ごとに必要です）。契約担当者経由でMercariへ登録を依頼してください。",
  RATE_LIMITED: "リクエストが多すぎます。しばらく待って再試行してください。",
  REMOTE_VALIDATION_ERROR: "送信内容にMercari側で受け付けられない項目があります。",
  NETWORK_ERROR: "Mercari Shops APIへ接続できません（ネットワークエラー）。",
  TIMEOUT: "Mercari Shops APIからの応答が時間内に返りませんでした。しばらく待ってから再試行してください。",
  // HTTP 200なのに本文がJSONでない場合(WAF/プロキシの割り込みページ等)。
  // 以前はresponse.json()のSyntaxErrorがそのまま外へ伝播し、
  // 「Unexpected token < in JSON at position 0」のような生の例外文言が
  // 設定画面に出得た(§3.3「raw JavaScript exceptionをUIへ出さない」違反)。
  INVALID_RESPONSE: "Mercari Shops APIから想定外の形式の応答が返りました。",
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
  // TIMEOUTは「一時的に遅い/届かない」であってこちらの設定の誤りではない
  // ため、NETWORK_ERRORと同じくリトライ対象に含める(公式FAQも
  // DEADLINE_EXCEEDEDについて「一時的なタイムアウトが発生した可能性が
  // あります。リトライをお試しください」と案内している)。
  // 逆にBAD_REQUEST(400)とINVALID_RESPONSEは送り方・応答形式そのものの
  // 問題で、同じ内容を送り直しても結果は変わらないためリトライしない。
  return code === "RATE_LIMITED" || code === "NETWORK_ERROR" || code === "TIMEOUT" || code === "UNKNOWN_REMOTE_ERROR";
}

/**
 * HTTPステータスコードからの一次分類(client.tsのsingleRequestが
 * response.status確定後すぐ呼ぶ)。IP_NOT_ALLOWEDは403のうち文面から
 * それと分かるものだけを拾う特殊ケースなので、AUTH_FAILEDより先に
 * bodyTextを見て判定する必要がある — この関数自体はステータスのみで
 * 一次分類し、403の詳細な出し分けはclassifyForbiddenErrorへ委ねる。
 */
export function classifyHttpStatus(status: number): MercariErrorCode {
  // 公式ドキュメントFAQ(Error)「400エラー: JSON構文エラーやクエリ構文
  // エラー時」/「Authorizationヘッダーの指定ミス」/「環境とトークンの
  // 組み合わせ違い」— リトライしても直らないのでUNKNOWN_REMOTE_ERROR
  // (リトライ対象)とは別に分類する。
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return "AUTH_FAILED"; // classifyForbiddenErrorがbody次第でIP_NOT_ALLOWEDへ上書きする
  // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §4: 実際に報告された
  // HTTP 404の再調査(WebSearch、2026-08-30時点、複数回一貫して同じ内容を
  // 確認)で、Mercari Shops API公式ドキュメントに「未登録のIPアドレス
  // からのリクエストは404 NotFoundを返す」と明記されていることが判明した
  // ——以前は404を「他のどのカテゴリにも当てはまらない予期しないHTTP
  // ステータス」としてUNKNOWN_REMOTE_ERROR扱いにしていたが、実際には
  // Mercari側で明確に定義された意味を持つステータスだった(403ではなく
  // 404である点も含め公式記述と一致)。詳細:
  // docs/mercari-404-root-cause-20260830.md、lib/listing/mercari/
  // endpoints.tsのコメント参照。
  if (status === 404) return "IP_NOT_ALLOWED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UNKNOWN_REMOTE_ERROR"; // §29のカテゴリ一覧に5xx専用の名前が無いため、リトライ対象という性質だけ揃えてここへ分類
  return "UNKNOWN_REMOTE_ERROR"; // 401/403/404/429/5xx以外の、他のどのカテゴリにも当てはまらない予期しないHTTPステータス
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
