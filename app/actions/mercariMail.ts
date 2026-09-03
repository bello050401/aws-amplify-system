"use server";

import { revalidatePath } from "next/cache";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { validateGmailConnection } from "@/lib/messaging/email/gmailClient";
import {
  clearGmailCredentials,
  DEFAULT_GMAIL_QUERY,
  getGmailCredentials,
  setGmailCredentials,
} from "@/lib/messaging/email/gmailSecretStore";
import { ingestMercariNotificationMails, type MailIngestResult } from "@/lib/messaging/mercari/mailIngest";

/**
 * 2026-09-03 指示書 §13/§14/§31: メルカリShops通知メール取り込みのServer Action層。
 *
 * 【秘密情報】client_secret / refresh_token は Server Action の引数として
 * 受け取り、そのまま AWS Secrets Manager へ入る。**戻り値には一切含めない**
 * (§31「Refresh tokenを平文ログへ出さない」)。保存済みの値を画面へ読み戻す
 * 関数も用意しない。
 */

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function requireAdmin(): Promise<string | null> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") throw new Error("この操作にはADMIN権限が必要です。");
  return getCurrentInventoryUserEmail();
}

async function requireEditor(): Promise<string | null> {
  const role = await getInventoryRole();
  if (role !== "ADMIN" && role !== "EDITOR") throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
  return getCurrentInventoryUserEmail();
}

export interface GmailStatus {
  configured: boolean;
  /** 監視中の検索条件。秘密情報ではないので表示してよい。 */
  query: string;
}

export async function getGmailStatusAction(): Promise<GmailStatus> {
  await requireEditor();
  const creds = await getGmailCredentials();
  return { configured: creds !== null, query: creds?.query ?? DEFAULT_GMAIL_QUERY };
}

export async function setGmailCredentialsAction(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  query: string;
}): Promise<ActionResult<null>> {
  try {
    await requireAdmin();
    const clientId = params.clientId.trim();
    const clientSecret = params.clientSecret.trim();
    const refreshToken = params.refreshToken.trim();
    if (!clientId || !clientSecret || !refreshToken) {
      return { ok: false, error: "クライアントID・クライアントシークレット・リフレッシュトークンをすべて入力してください。" };
    }
    const query = params.query.trim() || DEFAULT_GMAIL_QUERY;

    // 保存前に必ず疎通確認する。検証せずに保存すると、間違った値のまま
    // 「設定済み」と表示され、実際の問い合わせが来るまで気づけない。
    const validation = await validateGmailConnection({ clientId, clientSecret, refreshToken, query });
    if (!validation.ok) return { ok: false, error: validation.message };

    await setGmailCredentials({ clientId, clientSecret, refreshToken, query });
    revalidatePath("/inventory/messages");
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "保存に失敗しました。" };
  }
}

export async function clearGmailCredentialsAction(): Promise<ActionResult<null>> {
  try {
    await requireAdmin();
    await clearGmailCredentials();
    revalidatePath("/inventory/messages");
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "削除に失敗しました。" };
  }
}

/**
 * 手動での取り込み。
 *
 * §13-2「今回の初期実装は、数分以内に問い合わせを取り込めればよい」に
 * 対して、まずは人が押せる口を用意する。定期実行は
 * scripts/ingest-mercari-mail.ts を外部スケジューラから叩く形にしてあり、
 * どちらも同じ ingestMercariNotificationMails を呼ぶ(処理が二重にならない)。
 */
export async function ingestMercariMailAction(): Promise<ActionResult<MailIngestResult>> {
  try {
    const who = await requireEditor();
    const result = await ingestMercariNotificationMails({ who });
    revalidatePath("/inventory/messages");
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "取り込みに失敗しました。" };
  }
}
