import "server-only";
import { getNotifyBotAccessToken } from "./secretStore";

/**
 * 2026-09-03 指示書 §6/§7/§35: 社内通知用LINE Botへの送信。
 *
 * ── 顧客向けの送信ロックとは別物 ────────────────────────────────
 *
 * lib/messaging/line/adapter.ts の callLineApi は
 * `assertLineOutboundAllowed()`(既定で無効)を通る。あれは
 * **BELLO → 実顧客**の送信で、テスト段階で顧客へ誤送信しないための
 * ハードロック。このファイルが送るのは**大原さん本人の社内Bot**なので
 * 別の関数にしてある。
 *
 * 「同じLINE APIだから1つの関数にまとめる」をやると、社内通知を通す
 * ために顧客向けロックを緩めることになり、ロックの意味が消える。
 * **宛先の種類が違うものは、送信口ごと分ける。**
 *
 * ── では何が誤送信を防ぐのか ────────────────────────────────────
 *
 * 顧客向けのように環境変数で既定オフにはしない。通知が届かないことが
 * 既定になると、設定を1つ忘れた環境で「AIは動いているのに誰も気づかない」
 * という、この機能の存在意義そのものを失う状態になる。代わりに:
 *
 *   1. 送信先は follow イベントで登録された userId のみ
 *      (LineNotifySettings.targetUserId)。手入力の宛先を受け付けない
 *      ので、そもそも知らない相手へ飛ばない。
 *   2. その Bot を友だち追加した人にしか送れない(LINEの仕様)。
 *   3. 止めたいときは LINE_NOTIFY_DISABLED=true で即座に全停止できる。
 *
 * つまり「知らない宛先へ送れない」を構造で担保し、その上で緊急停止だけ
 * 環境変数に持たせる。
 */

const LINE_API_BASE = "https://api.line.me";

export type NotifyErrorCode =
  | "CONFIG_REQUIRED"
  | "NO_TARGET"
  | "DISABLED"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "REMOTE_VALIDATION_ERROR"
  | "NETWORK_ERROR"
  | "UNKNOWN_REMOTE_ERROR";

export class LineNotifyError extends Error {
  readonly code: NotifyErrorCode;
  /** 再試行して直る見込みがあるか。DEAD_LETTER へ落とすかの判断に使う。 */
  readonly retryable: boolean;
  constructor(code: NotifyErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "LineNotifyError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const LINE_NOTIFY_DISABLED_FLAG = "LINE_NOTIFY_DISABLED";

/** 緊急停止スイッチ。"true"(前後空白・大文字小文字は許容)のときだけ止める。 */
export function isLineNotifyDisabled(): boolean {
  return (process.env[LINE_NOTIFY_DISABLED_FLAG] ?? "").trim().toLowerCase() === "true";
}

function classifyStatus(status: number, bodyText: string): LineNotifyError {
  if (status === 401 || status === 403) {
    // 認証エラーは再試行しても直らない。トークンを入れ直すまで失敗し続ける
    // ので、リトライで浪費せず即座に人へ知らせる。
    return new LineNotifyError(
      "AUTH_FAILED",
      `LINE APIの認証に失敗しました(HTTP ${status})。通知BotのChannel Access Tokenを確認してください。`,
      false,
    );
  }
  if (status === 429) {
    return new LineNotifyError("RATE_LIMITED", "LINE APIのレート制限に達しました。時間をおいて再試行します。", true);
  }
  if (status >= 400 && status < 500) {
    // 400番台は基本的にリクエストが不正。同じ内容を送り直しても通らない。
    return new LineNotifyError(
      "REMOTE_VALIDATION_ERROR",
      `LINE APIがリクエストを拒否しました(HTTP ${status}): ${bodyText.slice(0, 300)}`,
      false,
    );
  }
  return new LineNotifyError(
    "UNKNOWN_REMOTE_ERROR",
    `LINE APIが予期しないエラーを返しました(HTTP ${status}): ${bodyText.slice(0, 300)}`,
    true,
  );
}

/**
 * 複数のテキストを**1回のpushで**送る。
 *
 * LINEのpush APIは messages を最大5件まで配列で受け取る。§7が求める
 * 「2通連続送信」を2回のHTTPに分けると、1通目だけ成功して2通目が失敗
 * するという中途半端な状態が起きうる —— 担当者が問い合わせ内容だけ見て
 * 返信案を待ち続けることになる。1リクエストにまとめれば、成否が必ず
 * 揃う(LINE側で部分失敗しない)。
 */
export async function sendNotifyPush(targetUserId: string, texts: string[]): Promise<void> {
  if (isLineNotifyDisabled()) {
    throw new LineNotifyError("DISABLED", `社内LINE通知は ${LINE_NOTIFY_DISABLED_FLAG}=true により停止中です。`, false);
  }
  if (!targetUserId) {
    throw new LineNotifyError(
      "NO_TARGET",
      "通知先が未登録です。設定画面のQRコードから社内通知Botを友だち追加してください。",
      false,
    );
  }
  const messages = texts.filter((t) => t.trim().length > 0).slice(0, 5);
  if (messages.length === 0) return;

  const accessToken = await getNotifyBotAccessToken();
  if (!accessToken) {
    throw new LineNotifyError(
      "CONFIG_REQUIRED",
      "社内通知BotのChannel Access Tokenが設定されていません。設定画面のLINE通知Botタブから登録してください。",
      false,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${LINE_API_BASE}/v2/bot/message/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ to: targetUserId, messages: messages.map((text) => ({ type: "text", text })) }),
    });
  } catch (err) {
    throw new LineNotifyError(
      "NETWORK_ERROR",
      `LINE APIへの接続に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw classifyStatus(res.status, text);
  }
}

export interface NotifyBotInfo {
  displayName: string | null;
  basicId: string | null;
  pictureUrl: string | null;
}

/**
 * §6/§24相当: トークンが本当に有効かを確かめる。`GET /v2/bot/info` は
 * Channel Access Token だけで叩ける公開エンドポイントで、副作用が無い
 * (誰にもメッセージが飛ばない)ので接続確認に使える。
 *
 * Channel Secret はこのAPIでは検証できない(署名検証にしか使われない)。
 * それでも一緒に保存させるのは、後から webhook を有効化するときに
 * 「片方だけ入っている」状態を作らないため。
 */
export async function validateNotifyBotConnection(accessToken: string): Promise<{ ok: boolean; message: string; info: NotifyBotInfo | null }> {
  if (!accessToken.trim()) return { ok: false, message: "Channel Access Tokenを入力してください。", info: null };
  try {
    const res = await fetch(`${LINE_API_BASE}/v2/bot/info`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, message: classifyStatus(res.status, text).message, info: null };
    }
    const data = (await res.json()) as { displayName?: string; basicId?: string; pictureUrl?: string };
    return {
      ok: true,
      message: `接続できました(Bot名: ${data.displayName ?? "不明"})。`,
      info: {
        displayName: data.displayName ?? null,
        basicId: data.basicId ?? null,
        pictureUrl: data.pictureUrl ?? null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      message: `LINE APIへの接続に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      info: null,
    };
  }
}

/** follow イベントで登録した userId の表示名を引く。取れなくても致命的ではない。 */
export async function fetchNotifyTargetProfile(userId: string): Promise<{ displayName: string | null }> {
  const accessToken = await getNotifyBotAccessToken();
  if (!accessToken) return { displayName: null };
  try {
    const res = await fetch(`${LINE_API_BASE}/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { displayName: null };
    const data = (await res.json()) as { displayName?: string };
    return { displayName: data.displayName ?? null };
  } catch {
    // 表示名が取れなくても通知は送れる。ここで失敗を投げると、友だち追加
    // そのものが失敗したように見えてしまう。
    return { displayName: null };
  }
}
