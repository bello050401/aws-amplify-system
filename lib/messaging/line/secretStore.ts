import "server-only";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  ResourceNotFoundException,
  ResourceExistsException,
} from "@aws-sdk/client-secrets-manager";

/**
 * BELLO統合業務OS指示書(2026-08-30) §51-52: LINE公式アカウントの
 * Channel Secret(Webhook署名検証用)+ Channel Access Token(Reply/Push
 * 送信用)の安全な保存先。lib/listing/mercari/secretStore.tsと全く同じ
 * アーキテクチャ(構造化JSON、TOKEN本体をNEVER log、PutSecretValue
 * 優先+ResourceNotFoundExceptionの時だけCreateSecretへフォールバック、
 * 削除は物理削除ではなくUNCONFIGURED_SECRET_PAYLOADへの書き戻し)を
 * LINE用に複製した別ファイル(意図的な重複 — 同ファイル冒頭コメント
 * 参照の理由と同じ)。
 *
 * amplify/backend.tsのlineChannelSecretがこの名前のSecretをCDKで新規
 * 作成する。実行ロールへの読み書き権限をdefineBackend()から直接付与
 * できない制約もMercari/ZAICOと全く同じ — Amplify Console側での
 * ADMINによる手動IAMポリシー追加が必要(完了報告のBLOCKED_BY_USER
 * 参照)。それまではgetLineChannelSecret/getLineAccessTokenが環境変数
 * LINE_CHANNEL_SECRET/LINE_CHANNEL_ACCESS_TOKENへフォールバックする。
 */

const SECRET_NAME = "bello/line-channel-secret";

const SECRET_DESCRIPTION =
  "BELLO在庫管理システム — LINE公式アカウントのChannel Secret/Channel Access Token(メッセージ機能専用)。設定画面(ADMIN限定)から読み書きする。";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

interface LineSecretPayload {
  configured: boolean;
  channelSecret?: string;
  accessToken?: string;
}

export const UNCONFIGURED_LINE_SECRET_PAYLOAD: LineSecretPayload = { configured: false };

let cachedClient: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  if (!cachedClient) cachedClient = new SecretsManagerClient({ region: REGION });
  return cachedClient;
}

function parsePayload(raw: string | undefined): LineSecretPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "configured" in parsed) return parsed as LineSecretPayload;
    return null;
  } catch {
    return null;
  }
}

function logAwsError(operation: string, err: unknown): void {
  const anyErr = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } } | null;
  console.error(
    `[line secretStore] ${operation} 失敗: ` +
      `name=${anyErr?.name ?? "(unknown)"} ` +
      `message=${anyErr?.message ?? String(err)} ` +
      `httpStatusCode=${anyErr?.$metadata?.httpStatusCode ?? "-"} ` +
      `requestId=${anyErr?.$metadata?.requestId ?? "-"} ` +
      `region=${REGION}`,
  );
}

function classifyAwsError(err: unknown): string {
  if (err instanceof ResourceNotFoundException) return "AWS Secrets ManagerにLINE用のSecretがまだ存在しません。";
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AccessDeniedException") {
    return "AWS Secrets Managerへのアクセス権限がありません。このアプリの実行ロールへ、対象Secret(bello/line-channel-secret)に対するsecretsmanager:GetSecretValue・PutSecretValueの権限を確認してください。";
  }
  if (name === "CredentialsProviderError" || /could not load credentials/i.test(message)) {
    return "AWS認証情報を確認できません。ローカル環境ではAWS CLIのプロファイル設定またはSSOログイン、AWS上で実行している場合は実行ロールの設定を確認してください。";
  }
  if (name === "UnrecognizedClientException" || name === "InvalidSignatureException" || name === "InvalidClientTokenId" || name === "ExpiredTokenException") {
    return "AWS認証情報が無効です(期限切れの可能性があります)。";
  }
  if (/region is missing/i.test(message)) return "AWSリージョンが設定されていません。環境変数 AWS_REGION を設定してください。";
  if (name === "TimeoutError" || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(message)) {
    return "AWS Secrets Managerへの接続に失敗しました(ネットワーク到達不可)。";
  }
  return `Secrets Managerへの保存に失敗しました(${name ?? "unknown error"})。詳細はサーバーログを確認してください。`;
}

/** channelSecret/accessTokenをまとめて1回のGetSecretValueで返す。 */
export async function getLineConnectionFromSecretsManager(): Promise<{ channelSecret: string | null; accessToken: string | null }> {
  try {
    const res = await getClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    const payload = parsePayload(res.SecretString);
    if (!payload?.configured) return { channelSecret: null, accessToken: null };
    return { channelSecret: payload.channelSecret?.trim() || null, accessToken: payload.accessToken?.trim() || null };
  } catch (err) {
    logAwsError("getSecretValue", err);
    return { channelSecret: null, accessToken: null };
  }
}

export async function setLineConnectionInSecretsManager(params: { channelSecret: string; accessToken: string }): Promise<void> {
  const payload: LineSecretPayload = { configured: true, channelSecret: params.channelSecret, accessToken: params.accessToken };
  const secretString = JSON.stringify(payload);

  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: secretString }));
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      logAwsError("putSecretValue", err);
      throw new Error(classifyAwsError(err));
    }
  }

  try {
    await getClient().send(new CreateSecretCommand({ Name: SECRET_NAME, Description: SECRET_DESCRIPTION, SecretString: secretString }));
    return;
  } catch (err) {
    if (err instanceof ResourceExistsException) {
      try {
        await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: secretString }));
        return;
      } catch (retryErr) {
        logAwsError("putSecretValue(after race with concurrent create)", retryErr);
        throw new Error(classifyAwsError(retryErr));
      }
    }
    logAwsError("createSecret", err);
    throw new Error(classifyAwsError(err));
  }
}

export async function clearLineConnectionInSecretsManager(): Promise<void> {
  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(UNCONFIGURED_LINE_SECRET_PAYLOAD) }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    logAwsError("putSecretValue(clear)", err);
    throw new Error(classifyAwsError(err));
  }
}
