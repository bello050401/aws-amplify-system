import { test, expect } from "@playwright/test";
import { E2E_AUTH_TOKEN } from "../playwright.config";

for (const width of [1440, 390]) {
  test(`共通情報を最初に開き、複数口のサイズを変更できる（幅${width}）`, async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await page.context().addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${E2E_AUTH_TOKEN}`, url: baseURL! }]);
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/inventory/e2e-inv-1/listing?channel=BASE");
    await expect(page.getByRole("tab", { name: "共通の商品情報" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "メルカリShops", exact: true }).click();
    await expect(page.getByText("共通の商品情報に未保存の変更があります。", { exact: false })).toBeHidden();
    await page.getByRole("tab", { name: "共通の商品情報" }).click();
    await expect(page.getByLabel("1口目の家財便サイズ")).toHaveValue("AUTO");
    await page.getByRole("button", { name: "＋ 配送する荷物を追加" }).click();
    await page.getByLabel("1口目の家財便サイズ").selectOption("C");
    await page.getByLabel("2口目の家財便サイズ").selectOption("A");
    await expect(page.getByLabel("2口目の荷物名")).toHaveCount(0);
    const reference = page.getByRole("region", { name: "送料込み参考価格" });
    await expect(reference.getByText("送料合計（2口）")).toBeVisible();
    await expect(reference).toContainText("2口目");
    // Fixture contains no rates: missing fees must not look like free shipping.
    await expect(reference.getByText("47都道府県の有効な料金が揃っていません").first()).toBeVisible();
    const common = page.getByRole("region", { name: "共通カテゴリと販売先別価格" });
    await common.getByLabel("商品カテゴリ", { exact: true }).selectOption("dining-chair");
    await common.getByText("販売先ごとのカテゴリを確認").click();
    await expect(common).toContainText("ダイニングチェア");
    await page.getByLabel("基準価格・送料別（円）", { exact: true }).fill("92000");
    await common.getByRole("button", { name: "基準価格と送料から設定" }).click();
    await expect(common.getByLabel("ヤフオク（送料別）", { exact: true })).toHaveValue("92000");
    await expect(common.getByLabel("メルカリShops（送料込み）", { exact: true })).toHaveValue("");
    await common.getByLabel("BASE（送料込み）", { exact: true }).fill("0");
    await expect(common).toBeVisible();
    await common.getByLabel("BASE（送料込み）", { exact: true }).fill("92806");
    await expect(reference).toContainText("¥92,000");
    await page.getByLabel("配送方法", { exact: true }).selectOption("SAGAWA");
    await expect(page.getByLabel("2口目の家財便サイズ")).toBeHidden();
    await page.getByLabel("配送方法", { exact: true }).selectOption("KAZAI");
    await expect(page.getByLabel("2口目の家財便サイズ")).toHaveValue("A");
    await page.getByRole("tab", { name: "メルカリShops", exact: true }).click();
    await expect(page.getByText("共通の商品情報に未保存の変更があります。", { exact: false })).toBeVisible();
    await page.getByRole("tab", { name: "共通の商品情報" }).click();
    await expect(page.getByLabel("2口目の家財便サイズ")).toHaveValue("A");
    await page.getByRole("button", { name: "2口目を削除" }).click();
    await expect(reference.getByText("送料合計（1口）")).toBeVisible();
    await expect(page.getByLabel("2口目の家財便サイズ")).toHaveCount(0);
    await expect(page.getByLabel("1口目の家財便サイズ")).toHaveValue("C");
    const sizes = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(sizes[0]).toBeLessThanOrEqual(sizes[1]);
    expect(errors).toEqual([]);
    await page.getByLabel("1口目の家財便サイズ").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/shipping-packages-${width}.png` });
  });
}
