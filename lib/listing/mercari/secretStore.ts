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
  /**
   * BELLO統合業務OS指示書(2026-08-30) §24/§26: MercariのUser-Agent
   * ヘッダに必要なAPIクライアント名/バージョン。TOKENと違い秘匿情報
   * そのものではないが、§26「Client Nameもserver-side
   * config。environment variable fallback可」— TOKENと全く同じ
   * 「Secrets Manager優先・環境変数フォールバック」の経路に乗せる
   * (設定画面から2つまとめて1回のvalidate+saveで保存できるようにする
   * ため、TOKENと同じsecretのpayloadへ同居させている — 新しいSecretを
   * もう一つ作る理由が無い)。
   */
  clientName?: string;
  clientVersion?: string;
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

/**
 * token/clientName/clientVersionをまとめて1回のGetSecretValueで返す —
 * 3つとも同じsecretの同じpayloadに同居しているため、個別に3回
 * GetSecretValueを呼ぶ理由が無い(§126のrate limit意識にも合う)。
 * 未設定(configured=false)の場合は3つとも null。
 */
export async function getMercariConnectionFromSecretsManager(): Promise<{ token: string | null; clientName: string | null; clientVersion: string | null }> {
  try {
    const res = await getClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    const payload = parsePayload(res.SecretString);
    if (!payload?.configured) return { token: null, clientName: null, clientVersion: null };
    return {
      token: payload.token?.trim() || null,
      clientName: payload.clientName?.trim() || null,
      clientVersion: payload.clientVersion?.trim() || null,
    };
  } catch (err) {
    logAwsError("getSecretValue", err);
    return { token: null, clientName: null, clientVersion: null };
  }
}

/** lib/listing/mercari/tokenAccess.tsからのみ呼ばれる薄いラッパー — 呼び出し側の意図(「TOKENだけ知りたい」)を名前で表す。 */
export async function getMercariTokenFromSecretsManager(): Promise<string | null> {
  return (await getMercariConnectionFromSecretsManager()).token;
}

/**
 * BELLO統合業務OS指示書(2026-08-30) §24: 設定画面の「接続確認して
 * 保存」ボタン1つで、APIクライアント名とTOKENをまとめて保存する
 * (§92: 保存前に必ず接続検証し、成功したものだけ確定する — この関数
 * 自体は検証済みの値を保存するだけで、検証は呼び出し元
 * app/actions/mercariSecret.tsのServer Action側が
 * lib/listing/mercari/adapter.tsのvalidateMercariConnectionで先に行う)。
 */
export async function setMercariConnectionInSecretsManager(params: { token: string; clientName: string; clientVersion?: string }): Promise<void> {
  const payload: MercariTokenSecretPayload = { configured: true, token: params.token, clientName: params.clientName, clientVersion: params.clientVersion };
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
