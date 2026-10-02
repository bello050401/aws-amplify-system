/** Official NE page flag: 0 private, 1 public. This says nothing about Mercari Shops publication. */
export type NextEnginePageVisibility = "MISSING" | "PRIVATE" | "PUBLIC" | "UNKNOWN";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export function parseNextEnginePageVisibility(payload: unknown, sku: string): NextEnginePageVisibility {
  if (!record(payload) || payload.result !== "success" || !Array.isArray(payload.data)) {
    throw new Error("NEの商品ページを確認できませんでした。");
  }
  const total = count(payload.count);
  if (total === 0 && payload.data.length === 0) return "MISSING";
  if (total !== 1 || payload.data.length !== 1 || !record(payload.data[0]) ||
      payload.data[0].goods_page_goods_code !== sku) {
    throw new Error("NEの商品ページを一意に確認できませんでした。");
  }
  const flag = payload.data[0].goods_page_display_flag;
  if (flag === "0" || flag === 0) return "PRIVATE";
  if (flag === "1" || flag === 1) return "PUBLIC";
  return "UNKNOWN";
}
