"use server";

import { revalidatePath } from "next/cache";
import { getBaseClient, type BaseItem } from "@/lib/base";
import { disconnectBase } from "@/lib/base/oauth";

/** Powers the search box (spec §2/§3). Runs server-side so BASE credentials never reach the browser. */
export async function searchBaseItems(query: string): Promise<BaseItem[]> {
  if (!query.trim()) return [];
  try {
    const result = await getBaseClient().search({ query });
    return result.items;
  } catch (err) {
    // Logged here (visible in the `npm run dev` terminal, not just the
    // browser) because the client only ever sees a thrown Error's message
    // — the stack and any cause get lost the moment this crosses the
    // Server Action boundary. Re-thrown as-is so /admin/search can show
    // the real reason (e.g. "BASEに接続されていません…", or a BaseApiError
    // with the actual HTTP status/body) instead of a generic failure.
    console.error("[searchBaseItems] BASE search failed for query:", query, err);
    throw err;
  }
}

/**
 * Supplementary "paste a BASE item URL" flow (spec §4). Accepts one URL
 * per line (or comma/space-separated) so a batch paste works too.
 */
export async function resolveBaseItemsFromUrls(text: string): Promise<BaseItem[]> {
  const ids = Array.from(new Set(Array.from(text.matchAll(/items\/(\d+)/g)).map((m) => m[1])));
  if (ids.length === 0) return [];
  try {
    return await getBaseClient().getItems(ids);
  } catch (err) {
    console.error("[resolveBaseItemsFromUrls] BASE item fetch failed for ids:", ids, err);
    throw err;
  }
}

export async function disconnectBaseAction() {
  await disconnectBase();
  revalidatePath("/admin/settings");
}
