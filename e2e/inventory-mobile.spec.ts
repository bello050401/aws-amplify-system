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

    /**
     * 第六ラウンド§17-18(P0-4): overflow=0だけでは検出できなかった
     * 実際の不具合(InventorySidebarのモバイル用トリガーバーが
     * flex-rowの兄弟としてalign-items:stretchで画面高さいっぱいまで
     * 縦に伸び、商品一覧を右へ圧迫していた)を実機計測で発見・修正した
     * ——同じ再発を防ぐため、密度メトリクスを数値で固定する回帰テスト。
     */
    test("モバイル用フィルターバーが画面幅いっぱいの横長バーで、商品一覧を圧迫しない", async ({ page }) => {
      await signInAsE2EFixtureRole(page, "ADMIN");
      await page.goto("/inventory");
      await expect(page.getByText("北欧デザインダイニングチェア").first()).toBeVisible({ timeout: 10_000 });

      const filterButton = page.getByRole("button", { name: /フィルター/ });
      await expect(filterButton).toBeVisible();
      const triggerBar = filterButton.locator("xpath=..");
      const barBox = await triggerBar.boundingBox();
      expect(barBox, "フィルタートリガーのbounding boxが取得できる").not.toBeNull();
      if (barBox) {
        // 横長バー(幅=viewport幅、高さは60px未満)であること——縦に
        // 伸びきった帯(以前の不具合では600px超)になっていないことを保証する。
        expect(barBox.width, `フィルターバーの幅(${barBox.width}px)はviewport幅(${viewport.width}px)と同等であるべき`).toBeGreaterThanOrEqual(viewport.width - 2);
        expect(barBox.height, `フィルターバーの高さ(${barBox.height}px)が60pxを超えている——縦に伸びきる不具合の再発`).toBeLessThan(60);
      }

      // above-the-fold行数(spec §158「一画面4〜6行以上を目標」)。
      const rowCount = await page.evaluate((vh) => {
        const lis = Array.from(document.querySelectorAll("ul.divide-y > li"));
        return lis.filter((li) => li.getBoundingClientRect().bottom <= vh).length;
      }, viewport.height);
      expect(rowCount, `above-the-fold商品行数(${rowCount}行)がspec目標(4〜6行以上)を下回っている`).toBeGreaterThanOrEqual(4);
    });
  });
}
