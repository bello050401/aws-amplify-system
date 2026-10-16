import type { ListingConditionCode, ListingDraftRecord, ListingImageRef, ListingShippingMethod } from "../types";

export type YahooAuctionInput = {
  title: string; description: string; condition: ListingConditionCode | null;
  format: "FIXED" | "AUCTION"; priceYen: number | null; buyNowYen: number | null;
  quantity: number; categoryId: string; categoryName: string;
  endAtJst: string; autoExtension: boolean;
};
export type YahooAuctionPayload = {
  schemaVersion: 1; input: YahooAuctionInput;
  source: { draftId: string; draftUpdatedAt: string; images: ListingImageRef[];
    shippingMethod: ListingShippingMethod };
};
export type YahooAuctionSaved = { revision: number; updatedAt: string; payload: YahooAuctionPayload };
const conditions = new Set(["NEW", "LIKE_NEW", "NO_NOTABLE_DAMAGE", "SLIGHT_DAMAGE", "DAMAGE", "BAD"]);
export const yahooInventoryIdValid = (id: unknown): id is string => typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export function initialYahooAuctionInput(draft: ListingDraftRecord | null): YahooAuctionInput {
  return { title: draft?.title ?? "", description: draft?.description ?? "", condition: draft?.condition ?? null,
    format: "FIXED", priceYen: null, buyNowYen: null, quantity: 1,
    categoryId: "", categoryName: "", endAtJst: "", autoExtension: true };
}

function validJstDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(value)) return false;
  const parsed = Date.parse(`${value}:00+09:00`);
  return Number.isFinite(parsed) && new Date(parsed + 9 * 3600_000).toISOString().slice(0, 16) === value;
}

/** Partial drafts can be saved. Missing publication fields are separate from malformed input. */
export function parseYahooAuctionInput(value: unknown): YahooAuctionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as YahooAuctionInput;
  if (typeof v.title !== "string" || v.title.length > 300 ||
      typeof v.description !== "string" || v.description.length > 30_000 ||
      v.condition !== null && !conditions.has(v.condition) ||
      !["FIXED", "AUCTION"].includes(v.format) ||
      ![v.priceYen, v.buyNowYen].every(n => n === null || Number.isSafeInteger(n) && n >= 1 && n <= 999_999_999) ||
      !Number.isSafeInteger(v.quantity) || v.quantity < 1 || v.quantity > 9 ||
      typeof v.categoryId !== "string" || !/^(?:[1-9]\d{0,11})?$/.test(v.categoryId) ||
      typeof v.categoryName !== "string" || v.categoryName.length > 300 ||
      typeof v.endAtJst !== "string" || v.endAtJst !== "" && !validJstDate(v.endAtJst) ||
      typeof v.autoExtension !== "boolean") return null;
  return { title: v.title.trim(), description: v.description, condition: v.condition,
    format: v.format, priceYen: v.priceYen, buyNowYen: v.format === "AUCTION" ? v.buyNowYen : null,
    quantity: v.quantity, categoryId: v.categoryId, categoryName: v.categoryName.trim(),
    endAtJst: v.endAtJst, autoExtension: v.format === "AUCTION" && v.autoExtension };
}

export function yahooPreparationIssues(input: YahooAuctionInput, imageCount: number, availableQuantity: number,
  now = Date.now()): string[] {
  const issues: string[] = [];
  if (!input.title.trim()) issues.push("商品名を入力してください。");
  else if ([...input.title].length > 65) issues.push("商品名を65文字以内にしてください。");
  if (!input.description.trim()) issues.push("商品説明を入力してください。");
  if (!input.condition) issues.push("商品の状態を選択してください。");
  if (!input.priceYen) issues.push(input.format === "FIXED" ? "即決価格を入力してください。" : "開始価格を入力してください。");
  if (input.format === "AUCTION" && input.priceYen && input.buyNowYen && input.buyNowYen < input.priceYen)
    issues.push("即決価格を開始価格以上にしてください。");
  if (!input.categoryId) issues.push("ヤフオクのカテゴリーを指定してください。");
  if (!input.endAtJst) issues.push("終了日時を指定してください。");
  else if (Date.parse(`${input.endAtJst}:00+09:00`) <= now) issues.push("終了日時を未来の日時に変更してください。");
  if (input.quantity > availableQuantity) issues.push("出品数量が現在の在庫数を超えています。");
  if (imageCount === 0) issues.push("上の共通下書きで出品画像を選んで保存してください。");
  if (imageCount > 10) issues.push("出品画像を10枚以内にしてください。");
  return issues;
}

// AWSJSON/DynamoDB maps may return object keys in a different order. Arrays
// retain their order because photo ordering is part of the saved selection.
function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonicalJsonValue(item)]));
  return value;
}

export function yahooPayloadsMatch(a: YahooAuctionPayload, b: YahooAuctionPayload): boolean {
  return JSON.stringify(canonicalJsonValue(a)) === JSON.stringify(canonicalJsonValue(b));
}

export function yahooSourceMatches(source: YahooAuctionPayload["source"], draft: ListingDraftRecord): boolean {
  return source.draftId === draft.id && source.draftUpdatedAt === draft.updatedAt &&
    source.shippingMethod === draft.shippingMethod &&
    JSON.stringify(canonicalJsonValue(source.images)) === JSON.stringify(canonicalJsonValue(draft.images));
}

export function parseYahooSaved(value: unknown): YahooAuctionSaved | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { revision: number; updatedAt: string; payload: unknown };
  let p: YahooAuctionPayload;
  try { p = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload; } catch { return null; }
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 ||
      typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt)) ||
      !p || p.schemaVersion !== 1 || !parseYahooAuctionInput(p.input) || !p.source ||
      typeof p.source.draftId !== "string" || !Number.isFinite(Date.parse(p.source.draftUpdatedAt)) ||
      !["KAZAI", "SAGAWA"].includes(p.source.shippingMethod) || !Array.isArray(p.source.images) ||
      p.source.images.length > 30 || p.source.images.some(i => !i || typeof i.storageKey !== "string" ||
        !i.storageKey || !Number.isSafeInteger(i.sortOrder))) return null;
  return { revision: row.revision, updatedAt: row.updatedAt, payload: p };
}

