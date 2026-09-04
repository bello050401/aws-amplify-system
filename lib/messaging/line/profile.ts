import "server-only";
import { getLineAccessToken } from "./tokenAccess";
import { fetchWithTimeout } from "@/lib/http/fetchWithTimeout";

/**
 * この経路の外部呼び出し。応答が返らないまま固まらないよう上限を持つ
 * （2026-09-04 健全化 PHASE 8 — lib/http/fetchWithTimeout.ts）。
 * どこが時間切れになったのかがログで分かるよう、名前を付けて渡す。
 */
const fetchExternal = (input: string | URL | Request, init?: RequestInit) =>
  fetchWithTimeout(input, init, { label: "LINEのプロフィール取得" });


/**
 * LINEの表示名を取得する。
 *
 * ## なぜ必要か —— 「不明な顧客」の原因そのもの
 *
 * Stagingの実データを見ると、LINE会話4件すべてで
 * `Conversation.externalCustomerId`(LINEのuserId、33文字)は保存されて
 * いるのに、`customerDisplayName` は DynamoDB の NULL だった。
 * 原因は単純で、**LINEのプロフィールAPIを呼ぶコードがどこにも
 * 存在しなかった** —— webhookが userId を保存するだけで終わっていた。
 * 画面はその null を見て「不明な顧客」と表示していた。
 *
 * ## 毎回は呼ばない
 *
 * 表示名は滅多に変わらないのに、LINE APIには回数制限がある。
 * Conversation に `customerDisplayName` と `customerNameFetchedAt` を
 * 持たせ、**取得済みで十分に新しければ呼ばない**。判断は
 * `shouldRefreshDisplayName()` に切り出してあり、純粋関数なので
 * 「いつ呼ぶか」だけを単体で検証できる。
 *
 * ## 取れなかったことを名前にしない
 *
 * ブロックされている・退会済み等でプロフィールが取れないことは普通に
 * ある。その場合に「不明な顧客」という**文字列を保存しない** ——
 * 保存してしまうと、後から本当に取得できるようになっても
 * 「取得済み」に見えて再取得されなくなる。取れなければ null のままにし、
 * 表示側が「不明な顧客」と出すかどうかを決める。
 */

const LINE_API_BASE = "https://api.line.me";

/** 表示名を取り直す間隔。名前はほぼ変わらないので長めでよい。 */
export const DISPLAY_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

export interface LineProfile {
  displayName: string;
  pictureUrl: string | null;
}

export type LineProfileResult =
  | { ok: true; profile: LineProfile }
  | { ok: false; reason: "NOT_CONFIGURED" | "NOT_FOUND" | "AUTH_FAILED" | "RATE_LIMITED" | "NETWORK_ERROR" | "UNKNOWN"; message: string };

/**
 * 取得しに行くべきか。
 * @param fetchedAt 最後に取得を試みた時刻(ISO)。未取得ならnull。
 * @param hasName 現在名前を持っているか。
 */
export function shouldRefreshDisplayName(
  fetchedAt: string | null | undefined,
  hasName: boolean,
  now: number = Date.now(),
): boolean {
  // 一度も試していないなら必ず試す(既存4件がこれに当たる)。
  if (!fetchedAt) return true;
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return true;
  // 名前が取れていないなら、間隔を待たずに次の機会に試す ——
  // 一時的な失敗で永久に「不明な顧客」のままになるのを避ける。
  if (!hasName) return now - t > 60 * 60 * 1000; // 1時間
  return now - t > DISPLAY_NAME_TTL_MS;
}

export async function fetchLineProfile(userId: string): Promise<LineProfileResult> {
  const accessToken = await getLineAccessToken();
  if (!accessToken) {
    return { ok: false, reason: "NOT_CONFIGURED", message: "LINE Channel Access Tokenが未設定です。" };
  }

  let res: Response;
  try {
    res = await fetchExternal(`${LINE_API_BASE}/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, reason: "NETWORK_ERROR", message: err instanceof Error ? err.message : "LINE APIへ接続できませんでした。" };
  }

  if (res.status === 404) {
    // ブロック済み・友だち未追加など。異常ではないので警告にしない。
    return { ok: false, reason: "NOT_FOUND", message: "この利用者のプロフィールは取得できません(ブロック・未友だち等)。" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "AUTH_FAILED", message: "LINE APIの認証に失敗しました。Channel Access Tokenをご確認ください。" };
  }
  if (res.status === 429) {
    return { ok: false, reason: "RATE_LIMITED", message: "LINE APIのレート制限に達しました。" };
  }
  if (!res.ok) {
    return { ok: false, reason: "UNKNOWN", message: `LINE APIが予期しない応答を返しました(HTTP ${res.status})。` };
  }

  try {
    const data = (await res.json()) as { displayName?: string; pictureUrl?: string };
    const displayName = String(data.displayName ?? "").trim();
    if (!displayName) return { ok: false, reason: "NOT_FOUND", message: "表示名が空でした。" };
    return { ok: true, profile: { displayName, pictureUrl: data.pictureUrl ?? null } };
  } catch {
    return { ok: false, reason: "UNKNOWN", message: "LINE APIの応答を解釈できませんでした。" };
  }
}
