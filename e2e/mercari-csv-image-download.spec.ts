import { test, expect, type Page, type Download } from "@playwright/test";
import iconv from "iconv-lite";

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";

async function signIn(page: Page) {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${E2E_TOKEN}`, url: "http://127.0.0.1:3100" }]);
}

async function downloadToBuffer(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream is null");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function gotoListingsOverview(page: Page) {
  await page.goto("/inventory/listings");
  const countBadge = page.getByText(/件表示$/);
  const retryButton = page.getByRole("button", { name: "再試行" });
  await Promise.race([countBadge.waitFor({ state: "visible", timeout: 15_000 }), retryButton.waitFor({ state: "visible", timeout: 15_000 })]);
  if (await retryButton.isVisible()) await retryButton.click();
  await expect(countBadge).toBeVisible({ timeout: 15_000 });
}

test.describe("Mercari CSV画像URLの実ブラウザ検証", () => {
  test("旧ZIP・個別保存UIを表示しない", async ({ page }) => {
    await signIn(page);
    await page.goto("/inventory/e2e-inv-41/listing");
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("画像の受け渡し（CSV出力用）")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /画像をまとめてZIPで保存/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /画像を1枚ずつ保存/ })).toHaveCount(0);
  });

  test("CSVの商品画像列に取得可能なURLを出力する", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await gotoListingsOverview(page);
    await page.getByRole("button", { name: "CSVを作成" }).click();
    await page.getByPlaceholder("商品名・在庫IDで絞り込み").fill("LST-0020");
    await page.getByLabel("すべて選択").check();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTitle(/商品一括登録CSV/).click()]);
    const rows = iconv.decode(await downloadToBuffer(download), "cp932").trim().split("\n");
    expect(rows).toHaveLength(2);
    const imageUrl = rows[1].split(",")[0].replace(/^"|"$/g, "");
    expect(imageUrl).toMatch(/^https?:\/\//);
    const response = await page.request.get(imageUrl);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toMatch(/^image\//);
  });
});
