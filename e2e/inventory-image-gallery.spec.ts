import { test, expect, type Page } from "@playwright/test";

/**
 * 画像表示高速化・段階読込(P1、2026-09-12指示書 + 同日QA是正)の実React
 * 境界試験。
 *
 * lib/inventory/inventoryImageLoadState.ts の純粋関数(reduceBodyLoadState
 * /planHeroRender/planFullRender)自体は scripts/verify-inventory-image-
 * load-state.ts が Node 単体で(React/DOM無しで)境界値を確認済み——この
 * ファイルはそれとは別に、実際の InventoryImageGallery/InventoryThumbnail
 * コンポーネントが本物のブラウザ(実タイマー・実DOM・実<img>読み込み)の
 * 上で正しく配線されていることを確認する。
 *
 * 認証は`__inv_e2e_role`Cookie経由(既存のモバイルE2Eと同じ二重ゲート)。
 * 画像データはすべて lib/inventory/e2eFixtures.ts の合成fixture
 * (`"e2e-fixture:"`接頭辞、public/e2e-fixtures/*.svg — 完全合成、顧客
 * 画像は一切使わない)経由で、実S3/Cognitoには一切到達しない。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";

async function signIn(page: Page) {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${E2E_TOKEN}`, url: "http://127.0.0.1:3100" }]);
}

/** hero(メイン画像)の<img>を指す — InventoryImageGalleryのボタン内、常に1枚だけ存在する。 */
const hero = (page: Page) => page.getByRole("button", { name: "画像を拡大表示" }).locator("img");

function trackFixtureRequests(page: Page, filename: string): { count: () => number } {
  let count = 0;
  page.on("request", (req) => {
    if (req.url().includes(`/e2e-fixtures/${filename}`)) count++;
  });
  return { count: () => count };
}

test.describe("在庫詳細ギャラリー: 段階読込・拡大時のみ原本要求", () => {
  test("初期表示では原本(storageKey)を一切要求せず、拡大操作で初めて1回だけ要求する", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const original = trackFixtureRequests(page, "original.svg");
    await page.goto("/inventory/e2e-inv-1");
    await expect(hero(page)).toBeVisible({ timeout: 10_000 });
    // small先行表示が確定した時点で、原本はまだ一度も要求されていない
    // ——「詳細画面を開いただけでは原本を先読みしない」がこの機能の核心。
    expect(original.count(), "初期表示だけで原本(storageKey)が要求されている").toBe(0);

    await page.getByRole("button", { name: "画像を拡大表示" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // e2e-inv-1のoriginal-delayedは0.9秒遅延——本体到着を待つ。
    await page.waitForTimeout(1500);
    expect(original.count(), "拡大操作1回に対して原本要求がちょうど1回であること").toBe(1);
  });

  test("メイン画像: small(320px)が先に確定表示され、medium(960px)本体onLoad成功時にだけ差し替わる", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-1");
    await expect(hero(page)).toBeVisible({ timeout: 10_000 });
    await expect(hero(page)).toHaveAttribute("src", /small\.svg$/);

    // e2e-inv-1のmedium-delayedは1.2秒遅延で成功する。
    await expect(hero(page)).toHaveAttribute("src", /medium\.svg$/, { timeout: 5_000 });
  });

  test("medium本体が404で失敗しても、small表示を維持し続ける(クラッシュしない)", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-2");
    await expect(hero(page)).toBeVisible({ timeout: 10_000 });
    await expect(hero(page)).toHaveAttribute("src", /small\.svg$/);
    // medium-brokenは即404——反映を待っても表示が壊れない/差し替わらないことを確認。
    await page.waitForTimeout(1000);
    await expect(hero(page)).toHaveAttribute("src", /small\.svg$/);
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("原本本体失敗→再試行で回復する(実際の404→retry()→再署名→成功)", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-3");
    await expect(hero(page)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "画像を拡大表示" }).click();

    // 1回目は本体404 — 再試行UIが出る。
    await expect(page.getByText("元画像の読み込みに失敗しました。")).toBeVisible({ timeout: 5_000 });

    // 「再試行」— forceRefreshで必ず新しい署名を取り直し、2回目は成功する。
    await page.getByRole("button", { name: "再試行" }).click();
    await expect(page.getByText("元画像の読み込みに失敗しました。")).toBeHidden({ timeout: 5_000 });
    await expect(page.getByRole("dialog").locator("img")).toHaveAttribute("src", /original\.svg$/);
  });

  /**
   * 画像切替競合(実React境界) — lib/inventory/e2eFixtures.tsのe2e-inv-5
   * 参照。1枚目はmedium本体が1.2秒遅延、2枚目はmediumKeyを持たない
   * (small止まり)。1枚目選択直後・medium到着前に2枚目へ切り替えると、
   * 1枚目向けの遅延medium onloadが後から届く——これが2枚目の表示へ
   * 誤反映(stale flash)しないことを、実タイマー・実DOM経由で確認する。
   */
  test("画像切替競合: 旧選択の遅延medium onLoadが新しい選択の表示へ誤反映しない", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-5");
    await expect(hero(page)).toBeVisible({ timeout: 10_000 });
    await expect(hero(page)).toHaveAttribute("src", /small\.svg$/);

    // 1枚目のmedium-delayed(1.2秒)がまだ届く前に、間を置かず2枚目へ切り替える。
    await page.getByRole("button", { name: "2枚目を表示" }).click();

    // 1.2秒(1枚目のmedium到着タイミング)を跨いで待つ。
    await page.waitForTimeout(1800);

    // 2枚目はmediumKeyを持たないため、正しい実装ならsmall.svgのまま
    // ——1枚目のmedium.svgへ化けていたら競合が再発している。
    await expect(hero(page)).toHaveAttribute("src", /small\.svg$/);
  });
});

test.describe("在庫一覧: 画面外サムネイルの署名解決抑制", () => {
  /**
   * app/inventory/InventoryThumbnail.tsx の IntersectionObserver
   * (rootMargin: 200px)による画面外解決抑制を、実スクロール・実
   * ネットワークリクエストで確認する。全12行が同じ合成キー
   * ("e2e-fixture:small")を持つ(lib/inventory/e2eFixtures.tsの
   * makeRow参照)——e2e-fixtureキーは意図的にキャッシュされないため、
   * 行ごとの署名解決が独立したリクエストとして観測できる。
   */
  test("画面外の行は初期表示で解決を始めず、スクロールで初めて解決される", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 700 });
    await signIn(page);
    await page.goto("/inventory");
    await expect(page.getByRole("table")).toBeVisible({ timeout: 10_000 });

    // 全12行が同じ合成URL("/e2e-fixtures/small.svg")を参照するため、
    // ネットワークリクエスト数はブラウザ側の重複排除(同一URLの同時
    // フェッチの合流)で行数と一致しない——代わりに、
    // InventoryThumbnail.tsxが「画面外はプレースホルダの<div>のみ、
    // 画面内(またはその手前)になった行だけ実際の<img>要素へ切り替わる」
    // という実装であることを利用し、テーブル内の<img>要素数そのものを
    // 「解決済みの行数」の直接の証拠として数える。
    const resolvedImageCount = () => page.getByRole("table").locator("img").count();

    // 初回描画が落ち着くまで少し待つ(IntersectionObserverのコールバックも含む)。
    await page.waitForTimeout(800);
    const initialCount = await resolvedImageCount();
    expect(initialCount, "初期表示だけで全12行が<img>化している(画面外抑制が効いていない)").toBeLessThan(12);
    expect(initialCount, "可視範囲の行は初期表示で<img>化している").toBeGreaterThan(0);

    // 一覧下端までスクロールし、画面外だった行が解決されるのを待つ。
    // デスクトップ幅ではテーブル本体(InventoryTable.tsxの
    // `overflow-auto md:block`のdiv)がスクロールコンテナで、document
    // 自体はスクロールしない——そのコンテナのscrollTopを直接動かす。
    await page.evaluate(() => {
      const container = document.querySelector(".md\\:block.overflow-auto, .overflow-auto.md\\:block") as HTMLElement | null;
      if (container) container.scrollTop = container.scrollHeight;
    });
    await page.waitForTimeout(1000);
    expect(await resolvedImageCount(), "スクロール後は画面外だった行も<img>化している").toBeGreaterThan(initialCount);
  });
});
