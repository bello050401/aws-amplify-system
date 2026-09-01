import "server-only";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

/**
 * AgentCore Gateway を MCP(Model Context Protocol)で呼ぶための最小クライアント。
 *
 * 【なぜ自前で書くか】GatewayはHTTP上のJSON-RPCで、AWS SDKにこれを叩く
 * データプレーンAPIが無い(`aws bedrock-agentcore` には invoke-agent-runtime と
 * invoke-browser しか無いことを実測)。MCP SDKを依存に足すことも考えたが、
 * ここで必要なのは initialize / tools/list / tools/call の3つだけで、
 * SigV4署名を差し込む必要もある。lib/listing/mercari/relay.ts が
 * 「fetchにCAを差せないから node:https を使う」と判断したのと同じ理由で、
 * 必要な分だけを自分で持つ。
 *
 * 【認証】Gatewayは authorizerType=AWS_IAM で作ってあるので、リクエストを
 * SigV4で署名する。署名鍵は実行環境の既定の資格情報チェーンから取る ——
 * Amplify SSRでは実行ロール、手元ではAWS_PROFILEのSSO資格情報。
 * **APIキーは存在しない**(この方式を選んだ理由そのもの)。
 */

/** 署名対象のサービス名。Gatewayは bedrock-agentcore として署名を検証する。 */
const SIGNING_SERVICE = "bedrock-agentcore";
const REQUEST_TIMEOUT_MS = 20_000;

export interface McpToolDescription {
  name: string;
  description?: string;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/**
 * 資格情報の解決。
 *
 * 既存の依存(@aws-sdk/client-bedrock-runtime)が持つ資格情報プロバイダを
 * そのまま借りる。`@aws-sdk/credential-providers` を新たに足さないのは、
 * 同じチェーンを2つ持つ意味が無いため。
 */
let credentialsClient: BedrockRuntimeClient | null = null;

async function resolveCredentials(region: string) {
  if (!credentialsClient) credentialsClient = new BedrockRuntimeClient({ region });
  return credentialsClient.config.credentials();
}

/** GatewayのURLからリージョンを読む。URLに含まれているので設定を二重に持たない。 */
export function regionFromGatewayUrl(gatewayUrl: string): string {
  const m = gatewayUrl.match(/\.gateway\.bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com/);
  if (!m) throw new McpError(`GatewayのURLからリージョンを判別できません: ${gatewayUrl}`, null);
  return m[1];
}

/**
 * MCPのレスポンスを取り出す。
 *
 * Streamable HTTPトランスポートは `application/json` でも
 * `text/event-stream` でも返しうる。後者は `data: {...}` 行の羅列なので、
 * JSON-RPCの応答を含む最初のイベントを拾う。
 */
export function parseMcpBody(contentType: string, body: string): unknown {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        return JSON.parse(payload);
      } catch {
        // このイベントはJSONではない(コメント等)。次を見る。
      }
    }
    throw new McpError("MCPのイベントストリームにJSON-RPC応答が含まれていません。", null);
  }
  return JSON.parse(body);
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Gatewayへ1回だけJSON-RPCを投げる。
 *
 * セッションIDは、返ってきたら次の呼び出しへ引き継ぐ。MCPの
 * Streamable HTTPはサーバー側がセッションを要求する場合がある。
 */
async function rpc(
  gatewayUrl: string,
  region: string,
  method: string,
  params: Record<string, unknown> | undefined,
  session: { id: string | null },
  signal?: AbortSignal,
): Promise<{ result: unknown; notification: boolean }> {
  const isNotification = method.startsWith("notifications/");
  const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) payload.params = params;
  if (!isNotification) payload.id = Date.now() % 1_000_000;
  const body = JSON.stringify(payload);

  const url = new URL(gatewayUrl);
  const headers: Record<string, string> = {
    host: url.host,
    "content-type": "application/json",
    // Streamable HTTPは両方を受け付けると宣言する必要がある。
    accept: "application/json, text/event-stream",
  };
  if (session.id) headers["mcp-session-id"] = session.id;

  const signer = new SignatureV4({
    service: SIGNING_SERVICE,
    region,
    credentials: await resolveCredentials(region),
    sha256: Sha256,
  });
  const signed = await signer.sign({
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query: {},
    headers,
    body,
  });

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(gatewayUrl, {
    method: "POST",
    headers: signed.headers as Record<string, string>,
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId) session.id = sessionId;

  // 通知(notifications/*)には本文が返らない。202/204で終わる。
  if (isNotification) return { result: null, notification: true };

  const text = await res.text();
  if (!res.ok) {
    // 本文にはSecretは含まれない(署名ヘッダは送信側にしか無い)が、
    // 念のため長さを切って渡す。
    throw new McpError(`Gatewayが HTTP ${res.status} を返しました: ${text.slice(0, 300)}`, res.status);
  }
  const parsed = parseMcpBody(res.headers.get("content-type") ?? "", text) as JsonRpcResponse;
  if (parsed.error) throw new McpError(`MCPエラー ${parsed.error.code}: ${parsed.error.message}`, res.status);
  return { result: parsed.result, notification: false };
}

/**
 * 1回の検索のためのセッション。
 *
 * initialize → notifications/initialized → tools/list → tools/call の順で
 * 進む。tools/list を毎回引くのは、Gatewayが公開するツール名が
 * `<ターゲット名>___<ツール名>` の形になり、ターゲット名を変えると
 * 変わるため —— 名前を定数で持つと、構築スクリプト側の変更で静かに壊れる。
 */
export class McpSession {
  private readonly session: { id: string | null } = { id: null };
  private initialized = false;
  private toolsCache: McpToolDescription[] | null = null;

  constructor(
    private readonly gatewayUrl: string,
    private readonly region: string = regionFromGatewayUrl(gatewayUrl),
  ) {}

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await rpc(
      this.gatewayUrl,
      this.region,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bello-inquiry-research", version: "1.0.0" },
      },
      this.session,
      signal,
    );
    // 初期化完了の通知。応答は返らない。
    await rpc(this.gatewayUrl, this.region, "notifications/initialized", {}, this.session, signal).catch(() => undefined);
    this.initialized = true;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescription[]> {
    if (this.toolsCache) return this.toolsCache;
    await this.ensureInitialized(signal);
    const { result } = await rpc(this.gatewayUrl, this.region, "tools/list", {}, this.session, signal);
    const tools = ((result as { tools?: McpToolDescription[] })?.tools ?? []).map((t) => ({ name: t.name, description: t.description }));
    this.toolsCache = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.ensureInitialized(signal);
    const { result } = await rpc(this.gatewayUrl, this.region, "tools/call", { name, arguments: args }, this.session, signal);
    return result;
  }
}
