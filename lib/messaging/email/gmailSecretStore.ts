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
 * 2026-09-03 指示書 §13-2/§31: メルカリShops問い合わせ通知メールを読むための
 * Gmail OAuth 認証情報。
 *
 * ── なぜGmail APIなのか(SESではなく) ────────────────────────────
 *
 * §13-2 は「現行AWS/Amplify構成との相性・コスト・保守性を比較して選択」と
 * している。実測した状況:
 *
 *   SES受信 : このアカウントに検証済みドメインが**0件**、受信ルールも**0件**。
 *             使うにはドメイン検証 + MXレコード変更が要る。MXの変更は
 *             既存の業務メールに影響しうる、後戻りしにくい作業。
 *   Gmail   : メルカリの通知メールは**既にGmailへ届いている**。DNSを一切
 *             触らずに読み取れる。
 *
 * よってGmailを採る。取り込み口はインターフェースで分けてあるので、
 * 将来SES受信へ移すときもパーサと取り込み処理はそのまま使える。
 *
 * ── 保存するもの ────────────────────────────────────────────────
 *
 * §31「OAuth tokenをGit保存しない」「Refresh tokenを平文ログへ出さない」。
 * clientId / clientSecret / refreshToken の3つだけをここへ入れる。
 * アクセストークンは短命なので保存せず、都度リフレッシュする。
 */

const SECRET_NAME = "bello/gmail-oauth";

const SECRET_DESCRIPTION =
  "BELLO在庫管理システム — メルカリShops問い合わせ通知メール取り込み用のGmail OAuth認証情報(client_id / client_secret / refresh_token)。設定画面(ADMIN限定)から書き込む。";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

export interface GmailOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** 監視するGmailの検索条件。未設定なら既定値を使う。 */
  query?: string;
}

interface GmailSecretPayload extends Partial<GmailOAuthCredentials> {
  configured: boolean;
}

export const UNCONFIGURED_GMAIL_PAYLOAD: GmailSecretPayload = { configured: false };

/**
 * 既定の検索条件。
 *
 * `newer_than` を必ず付ける —— 付けないと初回実行で受信箱の全履歴を
 * 舐めることになり、**何年も前の問い合わせが「新着」として大量に通知
 * される**。取り込み側にも重複防止はあるが、そもそも取りに行かない。
 */
export const DEFAULT_GMAIL_QUERY = "from:mercari newer_than:7d";

let cachedClient: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  if (!cachedClient) cachedClient = new SecretsManagerClient({ region: REGION });
  return cachedClient;
}

function parsePayload(raw: string | undefined): GmailSecretPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "configured" in parsed) return parsed as GmailSecretPayload;
    return null;
  } catch {
    return null;
  }
}

/** §31 refresh token を絶対にログへ出さない。種別と通信情報だけ残す。 */
function logAwsError(operation: string, err: unknown): void {
  const anyErr = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } } | null;
  console.error(
    `[gmail secretStore] ${operation} 失敗: ` +
      `name=${anyErr?.name ?? "(unknown)"} ` +
      `httpStatusCode=${anyErr?.$metadata?.httpStatusCode ?? "-"} ` +
      `requestId=${anyErr?.$metadata?.requestId ?? "-"} ` +
      `region=${REGION}`,
  );
}

/**
 * どのAPIで落ちたかを文面に含める。
 *
 * ── なぜ必要か(実際に踏んだ) ────────────────────────────────────
 *
 * Secretがまだ存在しないと、保存は
 * `PutSecretValue` → ResourceNotFound → `CreateSecret` の順に進む。
 * 実行ロールに `CreateSecret` は**意図的に与えていない**(ZAICO/Mercari/
 * LINEと同じ方針。Secretは既存の外部リソースとして扱い、実行時に作らせない)
 * ため、ここで AccessDenied になる。
 *
 * 以前はどのAPIで失敗しても「GetSecretValue・PutSecretValueの権限を確認して
 * ください」と出していた。**その2つは許可されている**ので、指示どおり確認しても
 * 「権限はあるのにエラーが出る」となり原因に辿り着けない。実際に
 * bello/line-notify-bot と bello/gmail-oauth の両方でこれを踏んだ。
 *
 * 正しい対処は権限追加ではなく、**Secretを先に作っておくこと**。
 */
function classifyAwsError(err: unknown, operation?: "getSecretValue" | "putSecretValue" | "createSecret"): string {
  const name = err instanceof Error ? err.name : undefined;
  if (name === "AccessDeniedException") {
    if (operation === "createSecret") {
      return (
        `Secret(${SECRET_NAME})がまだ存在せず、作成する権限もありません。これは想定どおりの設計です` +
        `(実行ロールにCreateSecretは与えていません)。AWS管理者が次のコマンドで空のSecretを1度だけ作成してください: ` +
        `aws secretsmanager create-secret --name ${SECRET_NAME} --secret-string '{"configured":false}'`
      );
    }
    const action = operation === "getSecretValue" ? "GetSecretValue" : "PutSecretValue";
    return `AWS Secrets Managerへのアクセス権限がありません。実行ロールへ ${SECRET_NAME} に対する secretsmanager:${action} の権限を確認してください。`;
  }
  if (name === "CredentialsProviderError") return "AWS認証情報を確認できません。";
  return `Secrets Managerへの保存に失敗しました(${name ?? "unknown error"})。詳細はサーバーログを確認してください。`;
}

/**
 * 読み取りの結果。**「未設定」と「読めなかった」を区別する。**
 *
 * 以前はどちらも null を返していたため、権限不足やSecret未作成が
 * 画面上は「未設定」に見えていた。原因が全く違うものを同じ表示にすると、
 * 「設定したのに未設定のまま」で調査が止まる(§6.1「失敗を未設定として
 * 黙って表示しない」)。
 */
export type GmailCredentialState =
  | { kind: "configured"; credentials: GmailOAuthCredentials }
  /** Secretはあるが、まだ値が入っていない。 */
  | { kind: "unconfigured" }
  /** Secretそのものが存在しない。AWS管理者が1度だけ作る必要がある。 */
  | { kind: "secret-missing" }
  /** 読み取りに失敗した(権限・ネットワーク等)。理由を持つ。 */
  | { kind: "error"; message: string };

export async function readGmailCredentialState(): Promise<GmailCredentialState> {
  try {
    const res = await getClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    const payload = parsePayload(res.SecretString);
    if (!payload?.configured) return { kind: "unconfigured" };
    if (!payload.clientId || !payload.clientSecret || !payload.refreshToken) return { kind: "unconfigured" };
    return {
      kind: "configured",
      credentials: {
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        refreshToken: payload.refreshToken,
        query: payload.query?.trim() || DEFAULT_GMAIL_QUERY,
      },
    };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return { kind: "secret-missing" };
    logAwsError("getSecretValue", err);
    return { kind: "error", message: classifyAwsError(err, "getSecretValue") };
  }
}

export async function getGmailCredentials(): Promise<GmailOAuthCredentials | null> {
  const state = await readGmailCredentialState();
  return state.kind === "configured" ? state.credentials : null;
}

export async function setGmailCredentials(creds: GmailOAuthCredentials): Promise<void> {
  const payload: GmailSecretPayload = { configured: true, ...creds };
  const secretString = JSON.stringify(payload);
  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: secretString }));
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      logAwsError("putSecretValue", err);
      throw new Error(classifyAwsError(err, "putSecretValue"));
    }
  }
  try {
    await getClient().send(new CreateSecretCommand({ Name: SECRET_NAME, Description: SECRET_DESCRIPTION, SecretString: secretString }));
  } catch (err) {
    if (err instanceof ResourceExistsException) {
      await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: secretString }));
      return;
    }
    logAwsError("createSecret", err);
    throw new Error(classifyAwsError(err, "createSecret"));
  }
}

export async function clearGmailCredentials(): Promise<void> {
  try {
    await getClient().send(
      new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(UNCONFIGURED_GMAIL_PAYLOAD) }),
    );
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    logAwsError("putSecretValue(clear)", err);
    throw new Error(classifyAwsError(err, "putSecretValue"));
  }
}

export async function isGmailConfigured(): Promise<boolean> {
  return (await getGmailCredentials()) !== null;
}
