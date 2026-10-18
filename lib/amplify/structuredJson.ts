/** AppSync serializes AWSJSON on the wire. Older direct writes also stored the
 * serialized text in DynamoDB, adding a second JSON layer on a web read. Only
 * structured fields use this codec; ordinary title/description strings do not. */
export function decodeStructuredJson(raw: unknown): object | null {
  let value = raw;
  for (let depth = 0; depth < 3 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("保存済みの出品データの形式を確認してください。");
    }
  }
  if (value == null) return null;
  if (typeof value !== "object") {
    throw new Error("保存済みの出品データの形式を確認してください。");
  }
  return value;
}

const STRUCTURED_FIELDS: Record<string, readonly string[]> = {
  ListingDraft: ["images", "channelPrices", "shippingPackages"],
  ChannelListing: ["categoryMapping"],
  YahooAuctionPreparation: ["payload"],
};

/** The AppSync input is JSON text, but its resolver stores native maps/lists.
 * Keep the IAM/background writer equivalent without changing other models. */
export function normalizeDirectStructuredJson(model: string, input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  for (const field of STRUCTURED_FIELDS[model] ?? []) {
    if (input[field] !== undefined) result[field] = decodeStructuredJson(input[field]);
  }
  return result;
}
