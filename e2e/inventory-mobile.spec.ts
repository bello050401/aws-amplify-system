import { test, expect, type Page } from "@playwright/test";

/**
 * 第五ラウンド§7/§43 P1-A: Inventoryの実際の保護されたルートを
 * 375/390/430pxで描画し、横スクロールがゼロであることを実測する。
 *
 * 認証は`__inv_e2e_role`Cookie経由(lib/amplify/requireInventoryUser.ts
 * の二重ゲート付きbypass、playwright.config.tsの安全設計コメント参照)。
 * データはlib/inventory/e2eFixtures.tsの固定fixture(実AWSには一切
 * 到達しない)。
 */
const VIEWPORTS = [
  { name: "iPhone SE相当", width: 375, height: 667 },
  { name: "iPhone 12/13相当", width: 390, height: 844 },
  { name: "iPhone 14 Pro Max相当", width: 430, height: 932 },
];

async function signInAsE2EFixtureRole(page: Page, role: "ADMIN" | "EDITOR" | "VIEWER") {
  // playwright.config.tsのE2E_AUTH_TOKENと同じ値(直接importせず値を
  // ここに複製しているのは、webServerのenvとテストプロセスのimportが
  // 別プロセスで動く可能性がある構成に依存しないため)。
  const token = "e2e-local-test-token-not-a-real-secret-32c";
  await page.context().addCookies([
    {
      name: "__inv_e2e_role",
      value: `${role}:${token}`,
      url: "http://127.0.0.1:3100",
    },
  ]);
}

/** documentElement/bodyの横方向オーバーフローが無いことを数値で確認する(spec: CSS目視ではなく実測)。 */
async function assertNoHorizontalOverflow(page: Page, context: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
    };
  });
  expect(overflow.docScrollWidth, `${context}: document.scrollWidth(${overflow.docScrollWidth}) > clientWidth(${overflow.docClientWidth}) — 横スクロールが発生している`).toBeLessThanOrEqual(
    overflow.docClientWidth,
  );
  expect(overflow.bodyScrollWidth, `${context}: body.scrollWidth(${overflow.bodyScrollWidth}) > clientWidth(${overflow.bodyClientWidth}) — 横スクロールが発生している`).toBeLessThanOrEqual(
    overflow.bodyClientWidth,
  );
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} (${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("未ログイン時、保護ルートは/inventory/loginへリダイレクトされる(実際の認証ガードが機能している)", async ({ page }) => {
      await page.goto("/inventory");
      await expect(page).toHaveURL(/\/inventory\/login/);
      await assertNoHorizontalOverflow(page, "ログインページ");
    });

    test("在庫一覧ページ(実際のlayout+page+NavRail+Header+Toolbar+Sidebar+Table)が横スクロール無しで描画される", async ({ page }) => {
      await signInAsE2EFixtureRole(page, "ADMIN");
      await page.goto("/inventory");
      // 実際のInventoryTable/InventoryToolbarのDOMが実際にmountしたことの確認
      // (fixtureデータの1件目の商品名が表示されている=DB読み取りfixtureが
      // 実際にpage.tsx→InventoryTableまで届いている証拠)。
      await expect(page.getByText("北欧デザインダイニングチェア").first()).toBeVisible({ timeout: 10_000 });
      await assertNoHorizontalOverflow(page, "在庫一覧ページ");
    });

    test("在庫詳細ページが横スクロール無しで描画される", async ({ page }) => {
      await signInAsE2EFixtureRole(page, "ADMIN");
      await page.goto("/inventory/e2e-inv-1");
      await expect(page.getByText("北欧デザインダイニングチェア").first()).toBeVisible({ timeout: 10_000 });
      await assertNoHorizontalOverflow(page, "在庫詳細ページ");
    });
  });
}
