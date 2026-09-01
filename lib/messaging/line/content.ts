import "server-only";
import { getLineAccessToken } from "./tokenAccess";

/**
 * LINEに届いたメッセージの実体(画像バイナリ等)を取得する。
 *
 * エンドポイントは `api-data.line.me`(通常のAPIとホストが違う)。
 * 取得できるのは受信から一定期間だけなので、Webhookを受けた直後に
 * 呼ぶ前提で作ってある(lib/messaging/attachmentStore.ts のコメント参照)。
 */

const LINE_DATA_API_BASE = "https://api-data.line.me";

/**
 * 受け取る最大サイズ。LINEの画像は通常これより十分小さい。
 * 上限を置くのは、想定外に大きいものでSSRのメモリを使い切らないため。
 */
const MAX_CONTENT_BYTES = 20 * 1024 * 1024;

export type LineContentResult =
  | { ok: true; body: Uint8Array; contentType: string }
  | { ok: false; reason: string };

export async function fetchLineMessageContent(messageId: string): Promise<LineContentResult> {
  const accessToken = await getLineAccessToken();
  if (!accessToken) return { ok: false, reason: "LINE Channel Access Tokenが未設定です。" };

  let res: Response;
  try {
    res = await fetch(`${LINE_DATA_API_BASE}/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "LINEのコンテンツAPIへ接続できませんでした。" };
  }

  if (res.status === 404) return { ok: false, reason: "コンテンツの保存期間が過ぎているか、存在しません。" };
  if (!res.ok) return { ok: false, reason: `LINEのコンテンツAPIがエラーを返しました(HTTP ${res.status})。` };

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) return { ok: false, reason: "コンテンツが空でした。" };
  if (buffer.byteLength > MAX_CONTENT_BYTES) {
    return { ok: false, reason: `コンテンツが大きすぎます(${Math.round(buffer.byteLength / 1024 / 1024)}MB)。` };
  }

  return { ok: true, body: new Uint8Array(buffer), contentType };
}
