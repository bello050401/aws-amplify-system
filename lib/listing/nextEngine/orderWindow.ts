export type NextEngineOrderSummary = {
  orderId: string;
  shopId: string;
  importedAt: string;
  statusId: string;
};

export type NextEngineOrderWindow = { shopId: string; from: string; before: string };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const digits = (value: unknown, max: number): value is string =>
  typeof value === "string" && new RegExp(`^[1-9][0-9]{0,${max - 1}}$`).test(value);
const count = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

/** NE uses a wall-clock timestamp without timezone. Both bounds must use the same NE clock. */
export function parseNextEngineTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new Error("受注の期間を確認できませんでした。");
  const [year, month, day, hour, minute, second] = value.split(/[- :]/).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new Error("受注の期間を確認できませんでした。");
  }
  return date.getTime();
}

export function validateNextEngineOrderWindow(window: NextEngineOrderWindow): void {
  if (!digits(window.shopId, 12)) throw new Error("対象店舗を確認できませんでした。");
  const from = parseNextEngineTimestamp(window.from);
  const before = parseNextEngineTimestamp(window.before);
  if (before <= from || before - from > 86_400_000) throw new Error("受注の期間は24時間以内で指定してください。");
}

/** Returns a complete bounded window or fails. Replaying a window is safe using NE orderId as the dedupe key. */
export function parseNextEngineOrderWindow(payload: unknown, window: NextEngineOrderWindow): NextEngineOrderSummary[] {
  validateNextEngineOrderWindow(window);
  if (!record(payload) || payload.result !== "success" || !Array.isArray(payload.data)) {
    throw new Error("受注情報の応答を確認できませんでした。");
  }
  const total = count(payload.count);
  if (total === null || total > 50 || payload.data.length !== total) {
    throw new Error("受注件数が上限を超えたか、全件を確認できませんでした。期間を狭めてください。");
  }
  const from = parseNextEngineTimestamp(window.from);
  const before = parseNextEngineTimestamp(window.before);
  const seen = new Set<string>();
  return payload.data.map((value: unknown) => {
    if (!record(value) || !digits(String(value.receive_order_id), 18) ||
        String(value.receive_order_shop_id) !== window.shopId ||
        typeof value.receive_order_import_date !== "string" ||
        typeof value.receive_order_order_status_id !== "string" ||
        !/^[0-9]{1,4}$/.test(value.receive_order_order_status_id)) {
      throw new Error("対象店舗の受注情報を確認できませんでした。");
    }
    const orderId = String(value.receive_order_id);
    const importedAt = value.receive_order_import_date;
    const time = parseNextEngineTimestamp(importedAt);
    if (time < from || time >= before || seen.has(orderId)) throw new Error("受注情報の重複または期間不一致があります。");
    seen.add(orderId);
    return { orderId, shopId: window.shopId, importedAt, statusId: value.receive_order_order_status_id };
  });
}
