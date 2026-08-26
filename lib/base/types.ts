/**
 * BASE product shapes used throughout the app.
 *
 * ⚠️ UNCONFIRMED FIELD NAMES — see docs/NOTES_BASE_API.md
 * These mirror the fields the product spec asks for (item_id, title,
 * price, description, images, stock, variations, url, status) using the
 * naming BASE's public docs have historically used, but they have not
 * been verified against a live response in this environment. Before
 * `BASE_USE_MOCK=false` goes anywhere near production, confirm every
 * field name here against an actual `/1/items/detail` (or whatever the
 * real path turns out to be) response and fix any mismatches — do not
 * assume this file is correct.
 */

export interface BaseItemImage {
  url: string;
}

export interface BaseItemVariation {
  variationId: string;
  label: string; // e.g. a color/size name — do not invent one if BASE omits it
  stock: number;
}

export interface BaseItem {
  itemId: string;
  title: string;
  price: number;
  description: string;
  images: BaseItemImage[];
  stock: number;
  variations: BaseItemVariation[];
  itemUrl: string;
  isPublished: boolean;
  /** Brand/maker name, ONLY when BASE actually returns one — never inferred. */
  brand?: string;
}

export interface BaseSearchParams {
  query: string;
  offset?: number;
  limit?: number;
}

export interface BaseSearchResult {
  items: BaseItem[];
  hasMore: boolean;
  nextOffset?: number;
}

export interface BaseTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}
