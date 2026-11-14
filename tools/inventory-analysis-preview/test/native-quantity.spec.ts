import { expect, test } from "@playwright/test";

test("390px existing StaffApp detail opens quantity planning and persists the latest result", async ({ page }, testInfo) => {
  const origin = process.env.BELLO_NATIVE_PREVIEW_URL;
  test.skip(!origin, "Provide the Expo Metro fixture origin");
  const root = new URL(origin!);
  const blocked: string[] = [];
  await page.setViewportSize({ width: 390, height: 820 });
  await page.route("**/*", async route => {
    const request = new URL(route.request().url());
    if (request.protocol === "data:") return route.continue();
    if (request.origin !== root.origin || request.pathname.startsWith("/api/")) {
      blocked.push(request.href);
      return route.abort();
    }
    if (request.pathname !== "/" || route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(/<script src="[^"]+\.bundle\?[^"]+" defer><\/script>/,
      '<script src="/quantity-preview.bundle?platform=web&dev=true&hot=false&lazy=false" defer></script>');
    expect(html).toContain("quantity-preview.bundle");
    return route.fulfill({ response, body: html });
  });
  async function openDetail(mode: string) {
    await page.goto(new URL("/?fixture=" + mode, root).href);
    await page.getByRole("tab", { name: "在庫一覧" }).click();
    await page.getByRole("button", { name: /オーク無垢材 ベンチ.*数量/ }).click();
  }
  await openDetail("unregistered");
  await page.getByRole("button", { name: "適正数量の計算", exact: true }).click();
  await expect(page.getByRole("heading", { name: "適正数量の計算" })).toBeVisible();
  await expect(page.getByText("購入総額（全数量の合計）", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  const months = page.getByRole("textbox", { name: "販売期間（ヶ月）" });
  const count = page.getByRole("textbox", { name: "販売見込み（個）" });
  await months.fill("-1");
  await count.fill("0");
  await page.getByRole("button", { name: "計算する", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "月数に正の数" })).toBeVisible();
  await months.fill("0.5");
  await count.fill("1");
  await page.getByRole("button", { name: "残りのメンテナンス時間 選択してください" }).click();
  await page.getByRole("radio", { name: "0分", exact: true }).click();
  await page.getByRole("radio", { name: "重ねる", exact: true }).click();
  const price = page.getByRole("textbox", { name: "予定販売価格（1個あたり・円）" });
  await price.fill("8500");
  await page.getByRole("button", { name: "計算する", exact: true }).click();
  await expect(page.getByText("通常販売に残す", { exact: true })).toBeVisible();
  await expect(page.getByText("業販に回す", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("quantity-native-390.png") });
  await price.fill("8600");
  const save = page.getByRole("button", { name: "計算結果を保存", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "再計算", exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("heading", { name: "保存済みの計算結果" })).toBeVisible();
  await openDetail("unregistered");
  await expect(page.getByRole("heading", { name: "保存済みの計算結果" })).toBeVisible();
  await page.getByRole("button", { name: "適正数量の計算", exact: true }).click();
  await expect(price).toHaveValue("8600");
  await expect(months).toHaveValue("0.5");
  expect(blocked).toEqual([]);
});
