import "server-only";
import { getMercariEndpoint, getMercariEnvironment, type MercariEnvironment } from "./endpoints";
import { getMercariUserAgent } from "./tokenAccess";
import type { GraphQLResponse } from "./types";
import { MercariApiError, classifyHttpStatus, classifyForbiddenError, classifyGraphQLErrors, isRetryableMercariErrorCode } from "./errors";

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
    this.timeoutMs = Number(process.env.MERCARI_TIMEOUT_MS ?? 15000);
    this.maxRetries = Number(process.env.MERCARI_MAX_RETRIES ?? 3);
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

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new MercariApiError("NETWORK_ERROR", err instanceof Error ? err.message : "Network error calling Mercari Shops API");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      let code = classifyHttpStatus(response.status);
      if (response.status === 403) code = classifyForbiddenError(bodyText);
      throw new MercariApiError(code, `HTTP ${response.status}${bodyText ? `: ${bodyText}` : ""}`);
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const json = (await response.json()) as GraphQLResponse<TData>;

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

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
