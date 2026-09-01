import "server-only";
import { getMercariEndpoint, getMercariEnvironment, type MercariEnvironment } from "./endpoints";
import { getMercariUserAgent } from "./tokenAccess";
import type { GraphQLResponse } from "./types";
import { MercariApiError, classifyHttpStatus, classifyForbiddenError, classifyGraphQLErrors, isRetryableMercariErrorCode } from "./errors";
import { getMercariRelayUrl, postViaMercariRelay } from "./relay";

export { MercariApiError } from "./errors";
export type { MercariErrorCode } from "./errors";

/**
 * BELLO統合改修 master指示書 Phase D — origin/claude/
 * mercari-shops-auto-listing-ag0w6m branchのintegrations/mercari-shops/
 * MercariShopsClient.tsから移植。タイムアウト/リトライの考え方はその
 * ブランチの実装をそのまま踏襲。
 *
 * BELLO統合業務OS指示書(2026-08-30) §29/§90で、エラー分類を
 * `MercariApiError`(このファイルではなくlib/listing/mercari/errors.ts
 * が唯一の定義元 — 循環import回避のため、client.ts/endpoints.ts/
 * tokenAccess.tsのどこからも参照できる独立ファイルへ切り出した)の
 * `code`フィールドへ集約するよう拡張した。リトライ判定も
 * `isRetryableMercariErrorCode`(RATE_LIMITED/NETWORK_ERROR/
 * UNKNOWN_REMOTE_ERROR = 5xx等)経由に統一し、旧`RetryableHttpError`
 * という別クラスでのラップは廃止した。
 */
export class MercariShopsClient {
  private readonly environment: MercariEnvironment;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly getAccessToken: () => Promise<string>;
  private readonly getUserAgent: () => Promise<string>;

  constructor(params: { getAccessToken: () => Promise<string>; getUserAgent?: () => Promise<string>; environment?: MercariEnvironment }) {
    this.environment = params.environment ?? getMercariEnvironment();
    this.endpoint = getMercariEndpoint(this.environment);
    // 環境変数に数値でない値が入っていた場合、Number()はNaNを返す。
    // setTimeout(fn, NaN)は「0ms後」と解釈されるため、以前はMERCARI_TIMEOUT_MSに
    // 誤った値が入るだけで全リクエストが即座にabortされ、原因の分かりにくい
    // NETWORK_ERRORが出続ける状態になり得た。既定値へフォールバックする。
    this.timeoutMs = positiveIntFromEnv(process.env.MERCARI_TIMEOUT_MS, 15000);
    this.maxRetries = nonNegativeIntFromEnv(process.env.MERCARI_MAX_RETRIES, 3);
    this.getAccessToken = params.getAccessToken;
    // BELLO統合業務OS指示書(2026-08-30) §92: 保存前の接続確認は、まだ
    // Secrets Manager/環境変数に保存されていない「入力中の値」で検証
    // する必要がある — getAccessToken同様、呼び出し元が任意のUser-Agent
    // 解決関数を注入できるようにした。省略時はtokenAccess.tsの
    // getMercariUserAgent(Secrets Manager優先・環境変数フォールバック、
    // 実際の出品操作が使うのと同じ経路)を使う。
    this.getUserAgent = params.getUserAgent ?? getMercariUserAgent;
  }

  getEnvironment(): MercariEnvironment {
    return this.environment;
  }

  /**
   * - UIコンポーネントから直接呼び出さない — 必ず lib/listing/mercari/adapter.ts を経由する。
   * - Personal API Access Tokenは呼び出し元(getAccessToken)から都度取得し、このクラス内にもログにも保持・出力しない。
   * - GraphQLエラー/HTTPエラーは握り潰さず、必ず`code`付きの MercariApiError として投げる。
   * - RATE_LIMITED/NETWORK_ERROR/UNKNOWN_REMOTE_ERROR(5xx等)は指数バックオフで最大 maxRetries 回まで再試行。
   *   ミューテーションは二重実行を避けるため既定でリトライしない(disableRetry)。
   */
  async request<TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    variables: TVariables,
    options: { disableRetry?: boolean } = {},
  ): Promise<TData> {
    const maxAttempts = options.disableRetry ? 1 : this.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.singleRequest<TData, TVariables>(query, variables);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof MercariApiError && isRetryableMercariErrorCode(err.code);
        if (!retryable || attempt === maxAttempts) throw err;
        const backoffMs = 2 ** (attempt - 1) * 500;
        await sleep(backoffMs);
      }
    }
    throw lastError;
  }

  private async singleRequest<TData, TVariables>(query: string, variables: TVariables): Promise<TData> {
    let token: string;
    let userAgent: string;
    try {
      // tokenAccess.tsのgetAccessToken/getMercariUserAgent — どちらも
      // 未設定なら設定不備であってネットワークエラーではないので、下の
      // fetch用try/catch(ネットワーク→リトライ対象)より前に呼び、
      // CONFIG_REQUIREDとして即座にエラーにする(無駄なリトライをさせ
      // ない)。
      token = await this.getAccessToken();
      userAgent = await this.getUserAgent();
    } catch (err) {
      throw new MercariApiError("CONFIG_REQUIRED", err instanceof Error ? err.message : String(err));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §4.3: 秘密情報
    // (TOKEN本体)は絶対にログへ出さず、運用上判断できる非秘密情報だけ
    // 出す——endpoint/environment/GraphQL operation name/User-Agentが
    // 設定されたか/token present(真偽値)/token length。これにより、
    // 実際にAWS環境で404等が発生した際、実TOKENを晒すことなく
    // 「User-Agentは送られていたか」「どの環境・エンドポイントへ送った
    // か」を後からログで追跡できる。
    const operationName = extractGraphQLOperationName(query);

    // 中継(東京の固定IP)が設定されていればそちら経由。未設定なら従来どおり
    // Mercariへ直接接続する —— 既存の動作を一切変えないための分岐。
    const relayUrl = getMercariRelayUrl();

    const logContext = {
      endpoint: this.endpoint,
      environment: this.environment,
      operationName,
      // 障害の切り分けは「どちらの経路で送ったか」が分からないと始まらない。
      // 中継のURL自体は秘密ではないが、ログには経路の種別だけを残す。
      via: relayUrl ? "relay" : "direct",
      userAgentSet: Boolean(userAgent),
      tokenPresent: Boolean(token),
      tokenLength: token.length,
    };
    const body = JSON.stringify({ query, variables });

    let response: Response;
    try {
      response = relayUrl
        ? await postViaMercariRelay({
            relayUrl,
            environment: this.environment,
            body,
            token,
            userAgent,
            signal: controller.signal,
          })
        : await fetch(this.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              "User-Agent": userAgent,
            },
            body,
            signal: controller.signal,
          });
    } catch (err) {
      // AbortControllerによる打ち切りは「繋がらない」ではなく「時間内に
      // 返ってこなかった」— 利用者への説明も対処も異なるため、
      // NETWORK_ERRORへ一括りにせずTIMEOUTとして分類する(§3.3の
      // errorCode一覧でもNETWORK_ERRORとTIMEOUTは別項目)。
      const timedOut = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      const code = timedOut ? "TIMEOUT" : "NETWORK_ERROR";
      console.error(`[MercariShopsClient] ${code}:`, JSON.stringify({ ...logContext, timeoutMs: this.timeoutMs }), err instanceof Error ? err.message : err);
      // 中継経由のときは、そもそもMercariまで届いていない可能性がある。
      // 「Mercariが応答しなかった」と書くと、中継の停止・ポート閉塞・TLS不一致を
      // Mercari側の障害と読み違える —— 応答自体が返っていない以上
      // X-Bello-Relay-Error では区別できないので、ここで文言を分ける。
      const reason = timedOut ? `Timed out after ${this.timeoutMs}ms` : err instanceof Error ? err.message : "Network error calling Mercari Shops API";
      throw new MercariApiError(
        code,
        relayUrl
          ? `Mercari中継サーバーへ到達できませんでした (${reason})。Mercariまでリクエストが届いたか、およびTOKENの正否は判定できていません。`
          : reason,
      );
    } finally {
      clearTimeout(timer);
    }

    // 429は公式ドキュメントのRate Limitingに従い、リセット時刻を
    // X-Ratelimit-Resetヘッダから読み取れる — 秘密値ではないので、
    // 「いつ再試行できるのか」を運用者が判断できるようログと
    // causeMessageへ含める。
    const rateLimitReset = response.headers.get("x-ratelimit-reset") ?? undefined;

    // 中継**自身**が返したエラーか、Mercariが返したエラーかを必ず区別する。
    //
    // これが無いと、中継の共有鍵がずれているだけで401が返り、それが
    // AUTH_FAILED(=TOKENが拒否された)として扱われる。すると
    // connectionPolicy が TOKEN_REJECTED と判断し、**正しいMercariトークンを
    // 保存しなくなる**。原因は中継の設定なのに、画面には「TOKENが無効」と
    // 出る —— もっとも避けたい誤診なので、ここで明示的に分岐する。
    // 中継の障害はトークンの正否を判定できないだけなので NETWORK_ERROR。
    const relayError = response.headers.get("x-bello-relay-error");
    if (relayError) {
      const relayCode = relayError === "RATE" ? "RATE_LIMITED" : "NETWORK_ERROR";
      console.error(
        "[MercariShopsClient] relay error (not a Mercari error):",
        JSON.stringify({ ...logContext, status: response.status, relayError, code: relayCode }),
      );
      throw new MercariApiError(
        relayCode,
        `Mercari中継サーバーでエラーが発生しました (relay ${relayError}, HTTP ${response.status})。Mercariのトークンの正否は判定できていません。`,
      );
    }

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      let code = classifyHttpStatus(response.status);
      if (response.status === 403) code = classifyForbiddenError(bodyText);
      console.error(
        "[MercariShopsClient] non-OK response:",
        JSON.stringify({ ...logContext, status: response.status, code, ...(rateLimitReset ? { rateLimitReset } : {}) }),
      );
      const detail = bodyText ? `: ${bodyText}` : "";
      throw new MercariApiError(code, `HTTP ${response.status}${detail}${rateLimitReset ? ` (X-Ratelimit-Reset: ${rateLimitReset})` : ""}`);
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;

    // HTTP 200でも本文がJSONとは限らない(WAF/プロキシの割り込みHTML等)。
    // 以前はここのresponse.json()が無防備で、SyntaxErrorがMercariApiError
    // ではない生の例外として外まで伝播していた — 接続確認画面には
    // 「Unexpected token < in JSON at position 0」のような、利用者が
    // 判断できない文言がそのまま出得た。JSON化の失敗も分類済みの
    // MercariApiError(INVALID_RESPONSE)として扱う。
    let json: GraphQLResponse<TData>;
    try {
      json = (await response.json()) as GraphQLResponse<TData>;
    } catch (err) {
      console.error(
        "[MercariShopsClient] response body was not valid JSON:",
        JSON.stringify({ ...logContext, status: response.status, contentType: response.headers.get("content-type") ?? null }),
        err instanceof Error ? err.message : err,
      );
      throw new MercariApiError(
        "INVALID_RESPONSE",
        `HTTP ${response.status} but the body was not valid JSON (content-type: ${response.headers.get("content-type") ?? "unknown"})`,
        [],
        requestId,
      );
    }

    if (json === null || typeof json !== "object") {
      throw new MercariApiError("INVALID_RESPONSE", `HTTP ${response.status} but the body was not a JSON object`, [], requestId);
    }

    if (json.errors && json.errors.length > 0) {
      const code = classifyGraphQLErrors(json.errors);
      throw new MercariApiError(code, json.errors.map((e) => e.message).join("; "), json.errors, requestId);
    }
    if (!json.data) {
      throw new MercariApiError("UNKNOWN_REMOTE_ERROR", "Mercari Shops API returned no data", [], requestId);
    }
    return json.data;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ログ用にGraphQL文字列から`query Name`/`mutation Name`のNameだけを抜き出す(§4.3、秘密を含まない診断情報)。取れなければ"unknown"。 */
export function extractGraphQLOperationName(query: string): string {
  const m = /^\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
  return m?.[1] ?? "unknown";
}

/**
 * エラー応答の本文は、Cloudflare等のエッジが返すHTMLだと数百KBになる
 * ことがある(実測: api.mercari-shops.com/docs は1.3MB)。そのまま
 * MercariApiErrorのcauseMessageへ入れると、ログにも、場合によっては
 * 画面にも巨大な本文が流れ込む。原因の切り分けに必要なのは先頭だけなので
 * 上限を設けて切り詰める。
 */
const MAX_ERROR_BODY_CHARS = 500;

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length <= MAX_ERROR_BODY_CHARS) return text;
    return `${text.slice(0, MAX_ERROR_BODY_CHARS)}…(以下${text.length - MAX_ERROR_BODY_CHARS}文字省略)`;
  } catch {
    return "";
  }
}

/** 環境変数から正の整数を読む。未設定・数値でない・0以下ならフォールバック値。 */
export function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 環境変数から0以上の整数を読む(リトライ回数は0が有効な設定値)。 */
export function nonNegativeIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
