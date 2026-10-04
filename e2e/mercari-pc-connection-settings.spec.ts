import { expect, test } from "@playwright/test";

const token = "e2e-local-test-token-not-a-real-secret-32c";
test.use({ channel: "chrome" });

test("settings shows evidence-limited PC and Shops status without a read receipt", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${token}`,
    url: baseURL! }]);
  await page.goto("/inventory/settings?tab=mercariBridge");
  await expect(page.getByRole("button", { name: "メルカリShops PC連携" })).toHaveClass(/border-gray-900/);
  await expect(page.getByText("未確認（記録未取得）")).toHaveCount(2);
  await expect(page.getByText("未接続（この依頼の報告なし）")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Shopsログイン用のPCアプリを開く" }))
    .toHaveAttribute("href", "bello-mercari-bridge://open");
  await expect(page.getByText("デスクトップの「BELLO メルカリ照合」", { exact: false })).toBeVisible();
  await expect(page.getByText("現在オンラインかどうかは判定できません", { exact: false })).toBeVisible();
  await expect(page.getByText("出品可能", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "既存商品の照合画面を開く" })).toHaveAttribute(
    "href", "/inventory/mercari-bridge");
});

test("request-ID navigation clears the previous status and input", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${token}`,
    url: baseURL! }]);
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  await page.goto(`/inventory/settings?tab=mercariBridge&requestId=${first}`);
  const input = page.getByRole("textbox", { name: "読取依頼ID" });
  await expect(input).toHaveValue(first);
  await page.evaluate(id => window.history.pushState(null, "", `?tab=mercariBridge&requestId=${id}`), second);
  await expect(input).toHaveValue(second);
  await page.evaluate(() => window.history.pushState(null, "", "?tab=mercariBridge"));
  await expect(input).toHaveValue("");
  await expect(page.getByText("未確認（記録未取得）")).toHaveCount(2);
  await expect(page.getByText("未接続（この依頼の報告なし）")).toHaveCount(0);
});
