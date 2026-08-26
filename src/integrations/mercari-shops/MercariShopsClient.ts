import { getMercariEndpoint, getMercariEnvironment, type MercariEnvironment } from "./endpoints";
import type { GraphQLErrorItem, GraphQLResponse } from "./types/common";

export class MercariApiError extends Error {
  readonly errors: GraphQLErrorItem[];
  readonly requestId?: string;

  constructor(message: string, errors: GraphQLErrorItem[], requestId?: string) {
    super(message);
    this.name = "MercariApiError";
    this.errors = errors;
    this.requestId = requestId;
  }
}

interface RequestOptions {
  /** trueの場合、失敗時にリトライしない（ミューテーションの二重実行を避けるため）。 */
  disableRetry?: boolean;
}

/**
 * Mercari Shops GraphQL API の薄いクライアント。
 * - Reactコンポーネントから直接呼び出さないこと（指示書34項）。必ず
 *   `domain/adapters/MercariShopsAdapter` を経由する。
 * - Personal API Access Tokenは呼び出し元 (`getAccessToken`) から都度取得し、
 *   このクラス内にもログにも保持・出力しない。
 * - GraphQLエラー/HTTPエラーは握り潰さず `MercariApiError` として投げる（指示書39項）。
 * - 429/5xx は指数バックオフで最大 `maxRetries` 回まで再試行（指示書47項）。ミューテーションは
 *   二重実行を避けるため既定でリトライしない。
 */
export class MercariShopsClient {
  private readonly environment: MercariEnvironment;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly getAccessToken: () => Promise<string>;

  constructor(params: { getAccessToken: () => Promise<string>; environment?: MercariEnvironment }) {
    this.environment = params.environment ?? getMercariEnvironment();
    this.endpoint = getMercariEndpoint(this.environment);
    this.timeoutMs = Number(process.env.MERCARI_TIMEOUT_MS ?? 15000);
    this.maxRetries = Number(process.env.MERCARI_MAX_RETRIES ?? 3);
    this.getAccessToken = params.getAccessToken;
  }

  getEnvironment(): MercariEnvironment {
    return this.environment;
  }

  async request<TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    variables: TVariables,
    options: RequestOptions = {},
  ): Promise<TData> {
    const maxAttempts = options.disableRetry ? 1 : this.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.singleRequest<TData, TVariables>(query, variables);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof RetryableHttpError;
        if (!retryable || attempt === maxAttempts) {
          throw err instanceof RetryableHttpError ? err.cause : err;
        }
        const backoffMs = 2 ** (attempt - 1) * 500;
        await sleep(backoffMs);
      }
    }
    // 到達しないが型のため
    throw lastError;
  }

  private async singleRequest<TData, TVariables>(
    query: string,
    variables: TVariables,
  ): Promise<TData> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      // タイムアウト/ネットワークエラー。5xx同様リトライ対象。
      throw new RetryableHttpError(
        err instanceof Error ? err : new Error("Network error calling Mercari Shops API"),
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new RetryableHttpError(
        new Error(`Mercari Shops API returned HTTP ${response.status}`),
      );
    }

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw new MercariApiError(
        `Mercari Shops API request failed with HTTP ${response.status}`,
        [{ message: bodyText || response.statusText }],
      );
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const json = (await response.json()) as GraphQLResponse<TData>;

    if (json.errors && json.errors.length > 0) {
      throw new MercariApiError(
        json.errors.map((e) => e.message).join("; "),
        json.errors,
        requestId,
      );
    }
    if (!json.data) {
      throw new MercariApiError("Mercari Shops API returned no data", [], requestId);
    }
    return json.data;
  }
}

class RetryableHttpError extends Error {
  cause: Error;
  constructor(cause: Error) {
    super(cause.message);
    this.cause = cause;
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
