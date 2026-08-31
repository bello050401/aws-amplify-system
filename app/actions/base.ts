"use server";

import { revalidatePath } from "next/cache";
import { getBaseClient, BaseNotConfiguredError, type BaseItem } from "@/lib/base";
import { BaseApiError } from "@/lib/base/client";
import { BaseNotConnectedError, disconnectBase } from "@/lib/base/oauth";

/**
 * BASE商品検索のServer Action層。
 *
 * ## 例外ではなく戻り値でエラーを伝える(2026-09-01)
 *
 * 以前この2つの関数は、失敗を**そのままthrowして**クライアントへ伝えて
 * いた。コメントには「/admin/search が本当の理由(『BASEに接続されて
 * いません…』等)を表示できる」と書かれていたが、**production buildでは
 * それは成立しない**。
 *
 * Next.jsはServer Actionからthrowされた値のmessageを、production build
 * では常に安全側へ丸める(このリポジトリでは app/actions/ai.ts が、
 * Playwrightで実際に再現して確認済みの事実として詳しく記録している):
 *
 *   "An error occurred in the Server Components render. The specific
 *    message is omitted in production builds to avoid leaking sensitive
 *    details. ..."
 *
 * つまり利用者の画面に出ていたのはこの英語の技術文言であり、
 * §6.7が禁止している「raw stack trace / 意味の無い500」そのものだった。
 * dev modeでは正しく見えるため気付きにくい。
 *
 * そこで app/actions/ai.ts と同じく、**シリアライズ可能な戻り値**で
 * 結果を伝える形へ変えた。これによりNext.jsのmasking機構を経由しない。
 */

export type BaseFailureCode = "NOT_CONFIGURED" | "NOT_CONNECTED" | "API_ERROR" | "UNKNOWN";

export type BaseSearchActionResult = { ok: true; items: BaseItem[] } | { ok: false; error: string; code: BaseFailureCode };

/** 例外を、利用者が読める日本語と分類へ畳む。秘密値は含めない。 */
function describeBaseFailure(err: unknown): { error: string; code: BaseFailureCode } {
  if (err instanceof BaseNotConfiguredError) {
    return {
      error:
        "BASE APIのアプリ認証情報が設定されていないため、BASEの商品を取得できません。設定画面の「BASE連携」タブで状態を確認してください。",
      code: "NOT_CONFIGURED",
    };
  }
  if (err instanceof BaseNotConnectedError) {
    return {
      error: "BASEアカウントとの連携が完了していません。設定画面の「BASE連携」タブから接続してください。",
      code: "NOT_CONNECTED",
    };
  }
  if (err instanceof BaseApiError) {
    // BaseApiErrorのmessageにはBASEの応答本文が入り得るので、そのままは出さない。
    return {
      error: `BASEからの応答でエラーが返りました（HTTP ${err.status ?? "不明"}）。時間をおいて再度お試しください。`,
      code: "API_ERROR",
    };
  }
  return { error: "BASEの商品取得に失敗しました。時間をおいて再度お試しください。", code: "UNKNOWN" };
}

/** Powers the search box (spec §2/§3). Runs server-side so BASE credentials never reach the browser. */
export async function searchBaseItems(query: string): Promise<BaseSearchActionResult> {
  if (!query.trim()) return { ok: true, items: [] };
  try {
    const result = await getBaseClient().search({ query });
    return { ok: true, items: result.items };
  } catch (err) {
    // 技術的な詳細はサーバーログにだけ残す(§6.6)。
    console.error("[searchBaseItems] BASE search failed for query:", query, err);
    const { error, code } = describeBaseFailure(err);
    return { ok: false, error, code };
  }
}

/**
 * Supplementary "paste a BASE item URL" flow (spec §4). Accepts one URL
 * per line (or comma/space-separated) so a batch paste works too.
 */
export async function resolveBaseItemsFromUrls(text: string): Promise<BaseSearchActionResult> {
  const ids = Array.from(new Set(Array.from(text.matchAll(/items\/(\d+)/g)).map((m) => m[1])));
  if (ids.length === 0) return { ok: true, items: [] };
  try {
    return { ok: true, items: await getBaseClient().getItems(ids) };
  } catch (err) {
    console.error("[resolveBaseItemsFromUrls] BASE item fetch failed for ids:", ids, err);
    const { error, code } = describeBaseFailure(err);
    return { ok: false, error, code };
  }
}

export async function disconnectBaseAction() {
  await disconnectBase();
  revalidatePath("/admin/settings");
}
