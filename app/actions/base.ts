"use server";

import { getBaseClient, type BaseItem } from "@/lib/base";

/** Powers the search box (spec §2/§3). Runs server-side so BASE credentials never reach the browser. */
export async function searchBaseItems(query: string): Promise<BaseItem[]> {
  if (!query.trim()) return [];
  const result = await getBaseClient().search({ query });
  return result.items;
}

/**
 * Supplementary "paste a BASE item URL" flow (spec §4). Accepts one URL
 * per line (or comma/space-separated) so a batch paste works too.
 */
export async function resolveBaseItemsFromUrls(text: string): Promise<BaseItem[]> {
  const ids = Array.from(new Set(Array.from(text.matchAll(/items\/(\d+)/g)).map((m) => m[1])));
  if (ids.length === 0) return [];
  const items = await getBaseClient().getItems(ids);
  return items;
}
