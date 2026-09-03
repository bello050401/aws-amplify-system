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
 * 2026-09-03 指示書 §6-1: **社内通知用**LINE Botの Channel Secret /
 * Channel Access Token の保存先。
 *
 * ── なぜ既存の bello/line-channel-secret と分けるのか ────────────
 *
 * 同じ「LINE」でも別のチャネルだから。既存のSecretは
 * **顧客が問い合わせてくる公式LINEアカウント**のもので、Webhookの署名
 * 検証と(将来の)顧客への返信に使う。こちらは**大原さん本人へ社内通知を
 * 送るだけのBot**で、顧客とは一切繋がっていない。
 *
 * 1つのSecretに相乗りさせると、通知Botのトークンを差し替えるつもりで
 * 顧客向けチャネルのトークンを壊す事故が起きうる。さらに悪いことに、
 * 通知先を間違えたときの宛先が**実顧客**になる。用途が違うものは
 * 分けておく。
 *
 * ── 顧客向け送信ロックには触らない ──────────────────────────────
 *
 * lib/messaging/line/outboundGuard.ts が「BELLO → 外部LINE」を既定で
 * 止めている。このファイルが扱うのは社内通知Botなので、そのロックは
 * **一切緩めない**。通知Botの送信可否は独立したフラグで持つ
 * (lib/messaging/lineNotify/outboundGuard.ts)。
 *
 * ── 実装は既存を踏襲 ────────────────────────────────────────────
 *
 * 構造化JSON、TOKEN本体をログへ出さない、PutSecretValue優先 +
 * ResourceNotFoundException のときだけ CreateSecret、削除は物理削除では
 * なく未設定ペイロードの書き戻し —— lib/messaging/line/secretStore.ts と
 * 同じ(意図的な複製。Secret名・エラー文言・用途が違うだけ)。
 */

const SECRET_NAME = "bello/line-notify-bot";

const SECRET_DESCRIPTION =
  "BELLO在庫管理システム — 社内通知用LINE BotのChannel Secret/Channel Access Token(問い合わせAI通知専用、顧客向け公式LINEとは別チャネル)。設定画面(ADMIN限定)から読み書きする。";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

interface NotifyBotSecretPayload {
  configured: boolean;
  channelSecret?: string;
  accessToken?: string;
}

export const UNCONFIGURED_NOTIFY_BOT_PAYLOAD: NotifyBotSecretPayload = { configured: false };

let cachedClient: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  if (!cachedClient) cachedClient = new SecretsManagerClient({ region: REGION });
  return cachedClient;
}

function parsePayload(raw: string | undefined): NotifyBotSecretPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "configured" in parsed) return parsed as NotifyBotSecretPayload;
    return null;
  } catch {
    return null;
  }
}

/** トークン本体は絶対に出さない。種別と通信情報だけ残す(§6-1「値そのものをログへ出さない」)。 */
function logAwsError(operation: string, err: unknown): void {
  const anyErr = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } } | null;
  console.error(
    `[lineNotify secretStore] ${operation} 失敗: ` +
      `name=${anyErr?.name ?? "(unknown)"} ` +
      `message=${anyErr?.message ?? String(err)} ` +
      `httpStatusCode=${anyErr?.$metadata?.httpStatusCode ?? "-"} ` +
      `requestId=${anyErr?.$metadata?.requestId ?? "-"} ` +
      `region=${REGION}`,
  );
}

function classifyAwsError(err: unknown, operation?: string): string {
  if (err instanceof ResourceNotFoundException) return "AWS Secrets Managerに通知Bot用のSecretがまだ存在しません。";
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AccessDeniedException") {
    // どのAPIで落ちたかを書く。
    //
    // 以前はどのAPIで失敗しても「GetSecretValue・PutSecretValueの権限を
    // 確認してください」と出していたが、実際に起きたのは **CreateSecret の
    // 拒否**だった(Secretがまだ存在せず、PutSecretValue→CreateSecret へ
    // フォールバックした)。Get/Put は許可されていたので、指示どおり確認しても
    // 「権限はあるのにエラーが出る」となり原因に辿り着けない。
    //
    // 実行ロールに CreateSecret は**意図的に与えていない**(ZAICO/Mercari と
    // 同じ方針。Secretは既存の外部リソースとして扱い、実行時に作らせない)。
    // したがって正しい対処は権限追加ではなく、**Secretを先に作っておくこと**。
    if (operation === "createSecret") {
      return `Secret(${SECRET_NAME})がまだ存在せず、作成する権限もありません。これは想定どおりの設計です(実行ロールにCreateSecretは与えていません)。AWS管理者が次のコマンドで空のSecretを1度だけ作成してください: aws secretsmanager create-secret --name ${SECRET_NAME} --secret-string '{"configured":false}'`;
    }
    return `AWS Secrets Managerへのアクセス権限がありません。このアプリの実行ロールへ、対象Secret(${SECRET_NAME})に対するsecretsmanager:${operation === "getSecretValue" ? "GetSecretValue" : "PutSecretValue"}の権限を確認してください。`;
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

export async function getNotifyBotConnectionFromSecretsManager(): Promise<{ channelSecret: string | null; accessToken: string | null }> {
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

export async function setNotifyBotConnectionInSecretsManager(params: { channelSecret: string; accessToken: string }): Promise<void> {
  const payload: NotifyBotSecretPayload = {
    configured: true,
    channelSecret: params.channelSecret,
    accessToken: params.accessToken,
  };
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
    return;
  } catch (err) {
    if (err instanceof ResourceExistsException) {
      try {
        await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: secretString }));
        return;
      } catch (retryErr) {
        logAwsError("putSecretValue(after race with concurrent create)", retryErr);
        throw new Error(classifyAwsError(retryErr, "putSecretValue"));
      }
    }
    logAwsError("createSecret", err);
    throw new Error(classifyAwsError(err, "createSecret"));
  }
}

export async function clearNotifyBotConnectionInSecretsManager(): Promise<void> {
  try {
    await getClient().send(
      new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(UNCONFIGURED_NOTIFY_BOT_PAYLOAD) }),
    );
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    logAwsError("putSecretValue(clear)", err);
    throw new Error(classifyAwsError(err, "putSecretValue"));
  }
}

export type NotifyBotTokenSource = "secrets-manager" | "env-fallback" | "unconfigured";

/**
 * トークンの出どころ。環境変数へのフォールバックを残すのは、IAM権限の
 * 付与前でも動作確認できるようにするため(既存の tokenAccess.ts と同じ理由)。
 */
export async function getNotifyBotAccessToken(): Promise<string | null> {
  const fromSecretsManager = (await getNotifyBotConnectionFromSecretsManager()).accessToken;
  return fromSecretsManager ?? process.env.LINE_NOTIFY_BOT_ACCESS_TOKEN ?? null;
}

export async function getNotifyBotChannelSecret(): Promise<string | null> {
  const fromSecretsManager = (await getNotifyBotConnectionFromSecretsManager()).channelSecret;
  return fromSecretsManager ?? process.env.LINE_NOTIFY_BOT_CHANNEL_SECRET ?? null;
}

export async function getNotifyBotTokenSource(): Promise<NotifyBotTokenSource> {
  const fromSecretsManager = await getNotifyBotConnectionFromSecretsManager();
  if (fromSecretsManager.channelSecret && fromSecretsManager.accessToken) return "secrets-manager";
  if (process.env.LINE_NOTIFY_BOT_CHANNEL_SECRET && process.env.LINE_NOTIFY_BOT_ACCESS_TOKEN) return "env-fallback";
  return "unconfigured";
}

export async function isNotifyBotConnected(): Promise<boolean> {
  return (await getNotifyBotTokenSource()) !== "unconfigured";
}
