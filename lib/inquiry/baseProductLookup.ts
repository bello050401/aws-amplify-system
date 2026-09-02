import "server-only";
import { serverDataClient, inventoryAuthMode } from "@/lib/amplify/dataClient";
import { unwrapGet } from "@/lib/amplify/listAll";
import { getBaseClient } from "@/lib/base";
import type { BaseItem } from "@/lib/base/types";

/**
 * BASE商品ID → 商品情報。
 *
 * ── なぜ足したか（実測した症状） ────────────────────────────────
 *
 * URLから商品IDを取り出すところまでは、既存の `lib/inquiry/references.ts`
 * が**正しく動いていた**（14通りのURLパターンで実測、失敗0件）。
 * 壊れていたのはその先。
 *
 *   `BaseProductArchive` は 267件しか無い（Staging実測）。
 *   指示書の実例 `156144635` は**入っていない**。
 *
 * `productResolver` は「アーカイブから商品名を得て、それを手がかりに
 * 在庫を照合する」設計なので、アーカイブに無いIDは手がかりが1つも
 * 得られず、そのまま「該当なし」になっていた。URLという最も確実な
 * 手がかりを持っているのに使えていない状態。
 *
 * ── 直し方 ──────────────────────────────────────────────────────
 *
 * アーカイブに無ければ **BASE API へ直接聞く**。BASE APIクライアントは
 * 既にあり（`lib/base/index.ts` の `getBaseClient().getItem`）、EC出品や
 * 商品説明分析で使われている。新しいクライアントは作らない。
 *
 * ── 出典を必ず持ち回る ──────────────────────────────────────────
 *
 * どこから得た情報かを `source` で返す。「アーカイブの古い値」と
 * 「BASEの現在値」を混ぜて扱うと、価格や在庫状況の回答がずれる。
 */

export type BaseProductSource =
  /** 取り込み済みのBASE過去商品。BASEへ問い合わせていない。 */
  | "archive"
  /** BASE APIへ問い合わせて取得した現在の値。 */
  | "api"
  /** どちらにも無い（削除済み・非公開・IDが誤り）。 */
  | "not-found";

export interface BaseProductLookup {
  baseItemId: string;
  source: BaseProductSource;
  title: string | null;
  /** 照合に使いやすい形へ整えたタイトル（アーカイブにあるときだけ）。 */
  titleCore: string | null;
  price: number | null;
  stock: number | null;
  itemUrl: string | null;
  imageUrls: string[];
  /** BASE APIから取れた場合のみ。公開状態は現在値でしか分からない。 */
  isPublished: boolean | null;
}

function parseImageUrls(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // 壊れたJSONは「画像なし」。ここで例外にすると商品特定そのものが
    // 落ちる —— 画像は商品を特定するために必須の情報ではない。
    return [];
  }
}

function fromArchive(row: Record<string, unknown>): BaseProductLookup {
  return {
    baseItemId: String(row.baseItemId),
    source: "archive",
    title: typeof row.title === "string" ? row.title : null,
    titleCore: typeof row.titleCore === "string" ? row.titleCore : null,
    price: typeof row.price === "number" ? row.price : null,
    stock: typeof row.stock === "number" ? row.stock : null,
    itemUrl: typeof row.itemUrl === "string" ? row.itemUrl : null,
    imageUrls: parseImageUrls(row.imageUrlsJson),
    isPublished: typeof row.visible === "boolean" ? row.visible : null,
  };
}

function fromApi(item: BaseItem): BaseProductLookup {
  return {
    baseItemId: item.itemId,
    source: "api",
    title: item.title,
    titleCore: null,
    price: typeof item.price === "number" ? item.price : null,
    stock: typeof item.stock === "number" ? item.stock : null,
    itemUrl: item.itemUrl || null,
    imageUrls: (item.images ?? []).map((i) => i.url).filter(Boolean),
    isPublished: item.isPublished,
  };
}

/**
 * 1件引く。まず取り込み済みデータ、無ければBASE APIへ。
 *
 * BASE APIが落ちている・未接続の場合でも**例外にしない**。商品特定が
 * できないだけで、問い合わせ対応そのものは続けられる必要がある
 * （特定できなければ後段がURL送付を依頼する）。
 */
export async function lookupBaseProduct(baseItemId: string): Promise<BaseProductLookup> {
  const notFound: BaseProductLookup = {
    baseItemId,
    source: "not-found",
    title: null,
    titleCore: null,
    price: null,
    stock: null,
    itemUrl: null,
    imageUrls: [],
    isPublished: null,
  };

  if (!/^\d{1,20}$/.test(baseItemId)) return notFound;

  // 1) 取り込み済み。baseItemId が識別子なので get で一意に引ける。
  const archived = unwrapGet(
    await serverDataClient.models.BaseProductArchive.get({ baseItemId }, inventoryAuthMode),
    "BASE過去商品",
  );
  if (archived) return fromArchive(archived as unknown as Record<string, unknown>);

  // 2) BASE API。未接続・エラーは「特定できなかった」として扱う。
  try {
    const item = await getBaseClient().getItem(baseItemId);
    if (!item) return notFound;
    return fromApi(item);
  } catch (err) {
    // 商品IDや文面は出さない。何が起きたかの種別だけ残す。
    console.warn("[baseProductLookup] BASE APIから商品を取得できませんでした", {
      name: err instanceof Error ? err.name : "unknown",
    });
    return notFound;
  }
}

/** 複数件。同じIDを2回引かない。 */
export async function lookupBaseProducts(baseItemIds: string[]): Promise<BaseProductLookup[]> {
  const unique = [...new Set(baseItemIds)];
  // 一度に大量へ問い合わせない。1つの問い合わせ文に何十件も商品URLが
  // 並ぶことは実務上まず無く、あるとすればbotか誤送信。
  const capped = unique.slice(0, 5);
  return Promise.all(capped.map(lookupBaseProduct));
}
