/** The source total remains exact even when the displayed unit price is rounded. */
export type YahooAmountFields = {
  count: string;
  total: string;
  postage: string;
  unitPrice: string;
};

export function yahooPurchaseUnitPrice(itemTotal: number, shipping: number, quantity: number) {
  return Math.round((itemTotal + shipping) / quantity);
}

export function initialYahooAmounts(lot: { quantity: number; itemTotal: number; shipping: number | null }): YahooAmountFields {
  const shipping = lot.shipping ?? 0;
  return {
    count: String(lot.quantity),
    total: String(lot.itemTotal),
    postage: String(shipping),
    unitPrice: String(yahooPurchaseUnitPrice(lot.itemTotal, shipping, lot.quantity)),
  };
}

export function editYahooAmounts(row: YahooAmountFields, field: "count" | "postage" | "unitPrice", value: string): YahooAmountFields {
  if (row[field] === value) return row;
  const next = { ...row, [field]: value };
  const quantity = Number(next.count), shipping = Number(next.postage);
  if (field === "unitPrice") {
    // Explicit unit-price edits replace the purchase amount. Shipping is already included.
    next.total = value !== "" && next.count !== "" && next.postage !== ""
      ? String(Number(value) * quantity - shipping) : "";
  } else {
    next.unitPrice = next.count !== "" && quantity > 0 && next.total !== "" && next.postage !== ""
      ? String(yahooPurchaseUnitPrice(Number(next.total), shipping, quantity)) : "";
  }
  return next;
}

export function yahooAmountError(row: YahooAmountFields): string | null {
  const quantity = Number(row.count), total = Number(row.total), shipping = Number(row.postage), unit = Number(row.unitPrice);
  if (!row.count || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000)
    return "数量は1〜10,000点で入力してください。";
  if (!row.postage || !Number.isSafeInteger(shipping) || shipping < 0 || shipping > 2147483647)
    return "送料は0円以上の整数で入力してください。";
  if (!row.unitPrice || !row.total || ![unit, total].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647) || total + shipping > 2147483647)
    return "購入単価は送料を含む1点分の金額を入力してください。送料が購入金額を超えないようにしてください。";
  if (unit !== yahooPurchaseUnitPrice(total, shipping, quantity))
    return "購入単価と数量・送料を確認してください。";
  return null;
}
