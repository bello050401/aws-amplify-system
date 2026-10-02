/** Official Mercari Shops integration manual p21: page display 0 = private.
 * https://mrs.ne-receiver.com/manual
 * This guard is not a publication API and does not submit any product.
 */
export const isReservedNextEngineTestCode = (code: string): boolean => /^BELLO-NE-TEST-[A-Za-z0-9-]+$/.test(code);

// Existing markers may contain an older, longer code; only new uploads must obey
// Next Engine's 30-character product-code limit.
export const isUploadablePrivateTestCode = (code: string): boolean =>
  isReservedNextEngineTestCode(code) && code.length <= 30;

export function makePrivateMasterTestSku(dateStamp: string, randomHex: string): string {
  if (!/^[0-9]{8}$/.test(dateStamp) || !/^[A-F0-9]{6}$/.test(randomHex)) {
    throw new Error("専用テスト商品コードの生成に失敗しました。");
  }
  const sku = `BELLO-NE-TEST-${dateStamp}-${randomHex}`;
  if (!isUploadablePrivateTestCode(sku)) throw new Error("専用テスト商品コードの生成に失敗しました。");
  return sku;
}

export function assertPrivateTestPage(page: { goods_page_display_flag?: unknown; goods_page_goods_code?: unknown }, expectedTestCode: string): void {
  if (!isReservedNextEngineTestCode(expectedTestCode) || page.goods_page_goods_code !== expectedTestCode) {
    throw new Error("対象が専用テスト商品と一致しないため、登録を停止しました。");
  }
  if (page.goods_page_display_flag !== 0 && page.goods_page_display_flag !== "0") {
    throw new Error("非公開（0）を確認できないため、メルカリShopsのテスト登録を停止しました。");
  }
}

export const NEXT_ENGINE_TEST_PUBLICATION_POLICY = {
  visibility: "PRIVATE_ONLY",
  allowPublicListing: false,
  allowExistingProductUpdate: false,
} as const;
