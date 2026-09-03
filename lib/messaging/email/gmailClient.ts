import "server-only";
import { getGmailCredentials, type GmailOAuthCredentials } from "./gmailSecretStore";
import type { MercariMailInput } from "@/lib/messaging/mercari/notificationMailParser";

/**
 * 2026-09-03 指示書 §13-2: Gmail APIからメールを読む。
 *
 * ── 読み取り専用 ────────────────────────────────────────────────
 *
 * 使うスコープは `gmail.readonly` だけ。削除も送信もしない。
 * 万一トークンが漏れても、できるのは読むことだけに限定される。
 *
 * ── ライブラリを足さない ────────────────────────────────────────
 *
 * googleapis パッケージは巨大で、この用途(トークン更新 + 2つのRESTエンド
 * ポイント)には見合わない。fetch で足りる。
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Error {
  readonly code: "CONFIG_REQUIRED" | "AUTH_FAILED" | "RATE_LIMITED" | "NETWORK_ERROR" | "REMOTE_ERROR";
  constructor(code: GmailError["code"], message: string) {
    super(message);
    this.name = "GmailError";
    this.code = code;
  }
}

/**
 * アクセストークンを取る。
 *
 * 保存しない。アクセストークンは1時間で切れるので、保存すると「切れた
 * トークンを使い続けて失敗する」経路を自分で作ることになる。
 * リフレッシュは軽い(1リクエスト)ので、取り込みのたびに取り直す。
 */
async function getAccessToken(creds: GmailOAuthCredentials): Promise<string> {
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (err) {
    throw new GmailError("NETWORK_ERROR", `Googleの認証エンドポイントへ接続できませんでした: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    // レスポンス本文には client_secret は含まれないが、念のため長さを絞る。
    const text = await res.text().catch(() => "");
    if (res.status === 400 || res.status === 401) {
      throw new GmailError(
        "AUTH_FAILED",
        "Gmailの認証に失敗しました。リフレッシュトークンが失効している可能性があります。設定画面から再取得してください。",
      );
    }
    throw new GmailError("REMOTE_ERROR", `Googleの認証エンドポイントがエラーを返しました(HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new GmailError("AUTH_FAILED", "アクセストークンを取得できませんでした。");
  return data.access_token;
}

async function apiGet<T>(path: string, accessToken: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    throw new GmailError("NETWORK_ERROR", `Gmail APIへ接続できませんでした: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 429) throw new GmailError("RATE_LIMITED", "Gmail APIのレート制限に達しました。時間をおいて再実行してください。");
  if (res.status === 401 || res.status === 403) throw new GmailError("AUTH_FAILED", `Gmail APIの認証に失敗しました(HTTP ${res.status})。`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GmailError("REMOTE_ERROR", `Gmail APIがエラーを返しました(HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** Gmailは base64url。標準base64へ直してからデコードする。 */
function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

/**
 * MIMEツリーから text/plain と text/html を集める。
 *
 * multipart/alternative や multipart/related が入れ子になるので再帰する。
 * **片方しか無いメールがある**ため、両方を返して呼び出し側に選ばせる
 * (パーサ側は両方を使う)。
 */
function collectBodies(part: GmailPart | undefined, acc: { text: string[]; html: string[] }): void {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const data = part.body?.data;
  if (data) {
    if (mime === "text/plain") acc.text.push(decodeBase64Url(data));
    else if (mime === "text/html") acc.html.push(decodeBase64Url(data));
  }
  for (const child of part.parts ?? []) collectBodies(child, acc);
}

function header(msg: GmailMessage, name: string): string {
  const headers = msg.payload?.headers ?? [];
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export interface FetchedMail extends MercariMailInput {
  /** GmailのメッセージID。Message-IDヘッダが無いメールの重複判定に使う。 */
  gmailId: string;
}

/** いま使っている検索条件。画面表示と実際の検索を一致させるために公開する。 */
export async function currentGmailQuery(): Promise<string | null> {
  const creds = await getGmailCredentials();
  return creds?.query ?? null;
}

/**
 * 検索条件に合うメールの**IDだけ**を取ってくる。
 *
 * 本文まで取ると1通ごとにAPIを1回叩くため、30通で十数秒かかる。
 * 取り込み済みかどうかはIDだけで判定できるので、まずIDを取り、
 * **新しいものだけ本文を取りに行く**。2回目以降の実行がこれで一気に短くなる。
 */
export async function listMercariNotificationMailIds(maxResults = 30): Promise<{ ids: string[]; query: string }> {
  const creds = await getGmailCredentials();
  if (!creds) {
    throw new GmailError(
      "CONFIG_REQUIRED",
      "Gmailの認証情報が設定されていません。設定画面からGoogle OAuthの認証情報を登録してください。",
    );
  }
  const accessToken = await getAccessToken(creds);
  const query = creds.query ?? "";
  const list = await apiGet<{ messages?: { id: string }[] }>(
    `/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    accessToken,
  );
  return { ids: (list.messages ?? []).map((m) => m.id), query };
}

/**
 * 指定したIDのメールを取ってくる。
 *
 * @param maxResults 1回の取り込みで処理する上限。多すぎると1回の実行が
 *   長くなり、途中で失敗したときの巻き戻しが大きくなる。
 */
export async function fetchMercariNotificationMailsByIds(ids: string[]): Promise<FetchedMail[]> {
  if (ids.length === 0) return [];
  const creds = await getGmailCredentials();
  if (!creds) {
    throw new GmailError(
      "CONFIG_REQUIRED",
      "Gmailの認証情報が設定されていません。設定画面からGoogle OAuthの認証情報を登録してください。",
    );
  }
  const accessToken = await getAccessToken(creds);

  const mails: FetchedMail[] = [];
  for (const id of ids) {
    // 1通ずつ取る。format=full でMIME全体が返る。
    const msg = await apiGet<GmailMessage>(`/messages/${id}?format=full`, accessToken);
    const bodies = { text: [] as string[], html: [] as string[] };
    collectBodies(msg.payload, bodies);

    // Message-ID ヘッダを第一キーにする(§10「メールMessage-ID」)。
    // 無ければGmailのidで代用する —— 転送やエイリアスでMessage-IDが
    // 落ちることがあり、そこで重複判定を諦めると二重通知になる。
    const messageId = header(msg, "Message-ID") || `gmail:${msg.id}`;

    mails.push({
      gmailId: msg.id,
      messageId,
      subject: header(msg, "Subject"),
      from: header(msg, "From"),
      text: bodies.text.join("\n"),
      html: bodies.html.join("\n"),
      receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    });
  }
  return mails;
}

/** 設定画面の接続確認。副作用が無い(プロフィール取得のみ)。 */
export async function validateGmailConnection(creds: GmailOAuthCredentials): Promise<{ ok: boolean; message: string }> {
  try {
    const accessToken = await getAccessToken(creds);
    const profile = await apiGet<{ emailAddress?: string; messagesTotal?: number }>("/profile", accessToken);
    return { ok: true, message: `接続できました(${profile.emailAddress ?? "アカウント不明"})。` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "接続確認に失敗しました。" };
  }
}
