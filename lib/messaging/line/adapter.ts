import "server-only";
import { getLineAccessToken } from "./tokenAccess";
import { assertLineOutboundAllowed } from "./outboundGuard";
import type { LineWebhookBody, LineWebhookEvent, NormalizedLineIncomingMessage, LineContentKind } from "./types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §51-52: LINE Messaging APIの実際の
 * 呼び出し(Reply/Push送信・接続確認)+ Webhookボディの正規化。
 *
 * 【reply vs push、なぜpushを使うか】LINEのreplyToken(§46の送信前確認
 * フロー)は受信直後の短時間しか有効でない、という公式の設計制約がある
 * (「即時応答」用途のためのトークンで、人が下書きを確認してから送る
 * このアプリのフロー — AI下書き生成→人が編集→確認モーダル→送信 —
 * では受信からかなり時間が経ってから送信することが前提のため、
 * replyTokenは事実上使えない)。そのため実際の送信(lib/messaging/
 * service.tsのsendReply)はsendLinePush(userId起点、有効期限なし)を
 * 使う。sendLineReplyは公式APIの契約としては実装しておくが、現状
 * どこからも呼ばれない(将来「受信直後に自動応答する」機能を作る場合の
 * ためのコードとして残す)。
 */

const LINE_API_BASE = "https://api.line.me";

export type LineErrorCode = "CONFIG_REQUIRED" | "AUTH_FAILED" | "RATE_LIMITED" | "REMOTE_VALIDATION_ERROR" | "NETWORK_ERROR" | "UNKNOWN_REMOTE_ERROR";

export class LineApiError extends Error {
  code: LineErrorCode;
  constructor(code: LineErrorCode, message: string) {
    super(message);
    this.name = "LineApiError";
    this.code = code;
  }
}

function classifyLineHttpStatus(status: number, bodyText: string): LineApiError {
  if (status === 401 || status === 403) return new LineApiError("AUTH_FAILED", `LINE APIの認証に失敗しました(HTTP ${status})。Channel Access Tokenを確認してください。`);
  if (status === 429) return new LineApiError("RATE_LIMITED", "LINE APIのレート制限に達しました。しばらく待ってから再試行してください。");
  if (status >= 400 && status < 500) return new LineApiError("REMOTE_VALIDATION_ERROR", `LINE APIがリクエストを拒否しました(HTTP ${status}): ${bodyText.slice(0, 300)}`);
  return new LineApiError("UNKNOWN_REMOTE_ERROR", `LINE APIが予期しないエラーを返しました(HTTP ${status}): ${bodyText.slice(0, 300)}`);
}

async function callLineApi(path: string, accessToken: string, body: unknown): Promise<void> {
  // ★ BELLO → 外部LINE の実送信ハードロック(2026-09-02 指示書§K)。
  //
  // ここは LINE Messaging API へ実際にHTTPリクエストを出す**唯一の**
  // 場所。呼び出し側(UI / server action / API route / worker / retry /
  // 直接呼び出し)ごとに判定を置くと経路が増えるたびに1つ抜け、抜けた
  // 1本が実顧客への誤送信になる。だから入口ではなく出口で止める。
  //
  // 既定は無効。LINE_OUTBOUND_ENABLED=true を明示的に設定した場合だけ
  // 送信できる(lib/messaging/line/outboundGuard.ts)。
  assertLineOutboundAllowed();

  let res: Response;
  try {
    res = await fetch(`${LINE_API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LineApiError("NETWORK_ERROR", `LINE APIへの接続に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw classifyLineHttpStatus(res.status, text);
  }
}

/** §46: 人が確認した返信本文をLINEの相手(userId)へpushメッセージとして送る。 */
export async function sendLinePush(userId: string, text: string): Promise<void> {
  // 送信できないと決まっているなら、認証情報すら取りに行かない。
  // (callLineApi 側にも同じ判定がある —— あちらが最後の砦、こちらは
  //  「無効なのにSecrets Managerを叩く」無駄と、失敗理由が
  //  CONFIG_REQUIRED にすり替わるのを防ぐため。)
  assertLineOutboundAllowed();
  const accessToken = await getLineAccessToken();
  if (!accessToken) throw new LineApiError("CONFIG_REQUIRED", "LINE Channel Access Tokenが設定されていません。設定画面のLINEタブから登録してください。");
  await callLineApi("/v2/bot/message/push", accessToken, { to: userId, messages: [{ type: "text", text }] });
}

/** 受信直後の即時応答用(現状未使用 — ファイル冒頭コメント参照)。 */
export async function sendLineReply(replyToken: string, text: string): Promise<void> {
  assertLineOutboundAllowed();
  const accessToken = await getLineAccessToken();
  if (!accessToken) throw new LineApiError("CONFIG_REQUIRED", "LINE Channel Access Tokenが設定されていません。");
  await callLineApi("/v2/bot/message/reply", accessToken, { replyToken, messages: [{ type: "text", text }] });
}

/**
 * §24相当: 設定画面の「接続確認して保存」用。LINEの公式Bot情報取得API
 * (`GET /v2/bot/info`、Channel Access Tokenのみで疎通確認できる安定した
 * 公開エンドポイント)を叩き、実際にそのTOKENが有効か確認する。
 * Channel Secret自体はこのAPIでは検証できない(署名検証はWebhook受信
 * 時にしか使われないため)が、両方まとめて保存するUIの都合上ここで
 * 受け取る。
 */
export async function validateLineConnection(params: { channelSecret: string; accessToken: string }): Promise<{ ok: boolean; message: string; code?: LineErrorCode }> {
  if (!params.channelSecret.trim()) return { ok: false, message: "Channel Secretを入力してください。" };
  if (!params.accessToken.trim()) return { ok: false, message: "Channel Access Tokenを入力してください。" };

  try {
    const res = await fetch(`${LINE_API_BASE}/v2/bot/info`, { headers: { Authorization: `Bearer ${params.accessToken}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = classifyLineHttpStatus(res.status, text);
      return { ok: false, message: err.message, code: err.code };
    }
    return { ok: true, message: "接続を確認しました。" };
  } catch (err) {
    return { ok: false, message: `LINE APIへの接続に失敗しました: ${err instanceof Error ? err.message : String(err)}`, code: "NETWORK_ERROR" };
  }
}

/**
 * Webhookボディ(署名検証済み・JSON.parse後)から、このアプリが実際に
 * 処理する「テキストメッセージの受信」イベントだけを抜き出して正規化
 * する(純粋関数寄り — 外部I/Oは無い)。
 *   - type !== "message" のイベント(follow/unfollow/postback等)は
 *     現状無視する(§39: 今回のMessage coreの対象はテキスト会話のみ)。
 *   - 画像・スタンプ等も**捨てずに記録する**(2026-09-02)。以前は
 *     `message.type !== "text"` で無視しており、画像を送られても会話に
 *     何も残らなかった。本文の有無ではなく種別で扱いを分ける。
 *   - source.userIdが無いイベント(グループ/ルームでの発言等、1:1
 *     チャット以外)も無視する(customerDisplayNameを一意に紐付ける
 *     設計が1:1チャット前提のため — §39で言及されたLINE公式アカウント
 *     との1:1問い合わせが対象)。
 */
export function parseLineWebhookBody(body: LineWebhookBody): NormalizedLineIncomingMessage[] {
  const result: NormalizedLineIncomingMessage[] = [];
  for (const event of body.events ?? []) {
    const normalized = normalizeEvent(event);
    if (normalized) result.push(normalized);
  }
  return result;
}

/**
 * LINEのmessage.type を BELLO側の種別へ写す。
 * 知らない種別は捨てずに OTHER として残す —— 捨てると「何か届いたのに
 * 画面には何も無い」という、いちばん気づけない失われ方をする。
 */
function toContentKind(lineType: string | undefined): LineContentKind {
  switch (lineType) {
    case "text":
      return "TEXT";
    case "image":
      return "IMAGE";
    case "sticker":
      return "STICKER";
    case "file":
    case "video":
    case "audio":
      return "FILE";
    default:
      return "OTHER";
  }
}

/** 種別ごとの、本文が空のときに画面へ出す代わりの文言。 */
function placeholderBody(kind: LineContentKind): string {
  switch (kind) {
    case "IMAGE":
      return "[画像]";
    case "STICKER":
      return "[スタンプ]";
    case "FILE":
      return "[ファイル]";
    case "OTHER":
      return "[未対応の形式のメッセージ]";
    default:
      return "";
  }
}

function normalizeEvent(event: LineWebhookEvent): NormalizedLineIncomingMessage | null {
  if (event.type !== "message") return null;
  if (event.source?.type !== "user" || !event.source.userId) return null;
  if (!event.message?.id) return null;

  const kind = toContentKind(event.message.type);
  const text = event.message.text ?? "";

  // テキストなのに本文が空のイベントは、記録しても何も分からないので捨てる。
  // それ以外(画像・スタンプ等)は本文が空でも捨てない。
  if (kind === "TEXT" && !text.trim()) return null;

  return {
    externalMessageId: event.message.id,
    externalCustomerId: event.source.userId,
    body: text.trim() ? text : placeholderBody(kind),
    contentKind: kind,
    // 画像・動画・音声・ファイルはLINEのコンテンツAPIから実体を取れる。
    // contentProvider が "line" 以外(外部URL)の場合、コンテンツAPIでは取得できない。
    hasDownloadableContent:
      (kind === "IMAGE" || kind === "FILE") && (event.message.contentProvider?.type ?? "line") === "line",
    externalSentAt: new Date(event.timestamp).toISOString(),
    replyToken: event.replyToken ?? null,
  };
}
