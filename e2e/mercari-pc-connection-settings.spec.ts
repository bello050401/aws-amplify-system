import { expect, test } from "@playwright/test";

const token = "e2e-local-test-token-not-a-real-secret-32c";
test.use({ channel: "chrome" });

test("settings shows evidence-limited PC and Shops status without a read receipt", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${token}`,
    url: baseURL! }]);
  await page.goto("/inventory/settings?tab=mercariBridge");
  await expect(page.getByRole("button", { name: "メルカリShops PC連携" })).toHaveClass(/border-gray-900/);
  await expect(page.getByText("未接続（この依頼の報告なし）")).toBeVisible();
  await expect(page.getByText("ログイン未確認")).toBeVisible();
  await expect(page.getByText("現在オンラインかどうかは判定できません", { exact: false })).toBeVisible();
  await expect(page.getByText("出品可能", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "既存商品の照合画面を開く" })).toHaveAttribute(
    "href", "/inventory/mercari-bridge");
});
