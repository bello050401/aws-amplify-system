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
 * Mercari Shops Personal API Access Tokenの安全な保存先(BELLO統合改修
 * master指示書 Phase D)。lib/zaico/secretStore.tsと同一のアーキテクチャ
 * ・安全性の考え方(構造化JSON `{configured, token?}`、TOKEN本体を
 * NEVER log、PutSecretValue優先+ResourceNotFoundExceptionの時だけ
 * CreateSecretへフォールバック、削除は物理削除ではなく
 * UNCONFIGURED_SECRET_PAYLOADへの書き戻し)を、Mercari用に複製した別
 * ファイル — 既にAWS上で動作確認済みのZAICO側の実装(および、そこへ
 * 至った複数のインシデント調査で積み上げたコメント)には一切手を加えず、
 * 新しいSecret用に同じ安全なパターンをもう一つ用意するほうが、共通化
 * のために既存の動作確認済みコードを触るより安全という判断による、
 * 意図的な重複(app/inventory/(protected)/[id]/edit/EditInventoryForm.tsx
 * のformatDateTime重複と同じ理由)。
 *
 * amplify/backend.tsで、この名前のSecretはCDKが新規作成する
 * (`new Secret(...)`) — ZAICOのSecretとは異なり、Mercari用のSecretは
 * このアプリがAWSアカウント上に存在させる初めての実体であり、
 * 「既存の外部リソースをimportする」必要はない(ZAICOのSecretが
 * `Secret.fromSecretNameV2()`でimportされているのは、production環境で
 * 既にCDK管理外の実体として存在していたため — amplify/backend.tsの
 * コメント参照)。
 *
 * 実行ロールへの読み書き権限をdefineBackend()から直接付与できない制約
 * もZAICOと全く同じ(Amplify Hosting Next.js SSRコンピュートの実行ロール
 * は`defineBackend()`のリソース一覧に含まれない) — こちらもAmplify
 * Console側でのADMINによる手動IAMポリシー追加が必要(完了報告の
 * BLOCKED_BY_USER参照)。それまではgetMercariAccessTokenが環境変数
 * MERCARI_ACCESS_TOKENへフォールバックする。
 */

const SECRET_NAME = "bello/mercari-access-token";

const SECRET_DESCRIPTION =
  "BELLO在庫管理システム — Mercari Shops Personal API Access Token(EC出品機能専用)。設定画面(ADMIN限定)から読み書きする。";

/** lib/zaico/secretStore.tsと同じ理由(BELLOの実デプロイ先リージョン)でus-west-2をフォールバックにする。 */
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

interface MercariTokenSecretPayload {
  configured: boolean;
  token?: string;
}

/** IaCの初期値・削除後の値として書き込む「未設定」ペイロード。amplify/backend.tsのSecret初期値と完全に同じ形にすること。 */
export const UNCONFIGURED_MERCARI_SECRET_PAYLOAD: MercariTokenSecretPayload = { configured: false };

let cachedClient: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  if (!cachedClient) cachedClient = new SecretsManagerClient({ region: REGION });
  return cachedClient;
}

function parsePayload(raw: string | undefined): MercariTokenSecretPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "configured" in parsed) return parsed as MercariTokenSecretPayload;
    return null;
  } catch {
    return null;
  }
}

/** lib/zaico/secretStore.tsのlogAwsErrorと同じ方針 — TOKEN本体は絶対に出さず、診断情報のみ。 */
function logAwsError(operation: string, err: unknown): void {
  const anyErr = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } } | null;
  console.error(
    `[mercari secretStore] ${operation} 失敗: ` +
      `name=${anyErr?.name ?? "(unknown)"} ` +
      `message=${anyErr?.message ?? String(err)} ` +
      `httpStatusCode=${anyErr?.$metadata?.httpStatusCode ?? "-"} ` +
      `requestId=${anyErr?.$metadata?.requestId ?? "-"} ` +
      `region=${REGION}`,
  );
}

/** lib/zaico/secretStore.tsのclassifyAwsErrorと同じ分類方針。 */
function classifyAwsError(err: unknown): string {
  if (err instanceof ResourceNotFoundException) return "AWS Secrets ManagerにMercari用のSecretがまだ存在しません。";
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AccessDeniedException") {
    return "AWS Secrets Managerへのアクセス権限がありません。このアプリの実行ロールへ、対象Secret(bello/mercari-access-token)に対するsecretsmanager:GetSecretValue・PutSecretValueの権限を確認してください。";
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

export async function getMercariTokenFromSecretsManager(): Promise<string | null> {
  try {
    const res = await getClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    const payload = parsePayload(res.SecretString);
    if (!payload?.configured) return null;
    return payload.token?.trim() || null;
  } catch (err) {
    logAwsError("getSecretValue", err);
    return null;
  }
}

export async function setMercariTokenInSecretsManager(token: string): Promise<void> {
  const payload: MercariTokenSecretPayload = { configured: true, token };
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

export async function clearMercariTokenInSecretsManager(): Promise<void> {
  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(UNCONFIGURED_MERCARI_SECRET_PAYLOAD) }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    logAwsError("putSecretValue(clear)", err);
    throw new Error(classifyAwsError(err));
  }
}
