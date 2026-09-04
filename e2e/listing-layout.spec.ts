import { test, expect, type Page } from "@playwright/test";

/**
 * 2026-09-04 EC出品改修指示書 §1/§2/§3/§26: EC出品画面のレイアウト。
 *
 * 実際のブラウザで /inventory/<id>/listing を描画して確かめる:
 *
 *   ・PC幅では右側に「在庫詳細・基本情報」が出る
 *   ・iPhone幅では右パネルが**描画されない**(下へ回さない、§3)
 *   ・説明文の初期高さが約4倍(4行→16行)
 *   ・説明文をユーザーがリサイズできる(resize機能を消していない)
 *   ・どの幅でも横スクロールが発生しない
 *
 * 認証は `__inv_e2e_role` Cookie 経由(既存のモバイルE2Eと同じ二重ゲート)。
 * データは lib/inventory/e2eFixtures.ts の固定fixtureで、実AWSへは
 * 一切到達しない。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
const INVENTORY_ID = "e2e-inv-1";
const LISTING_URL = `/inventory/${INVENTORY_ID}/listing`;

/** §3 「PC」とみなす幅。page.tsx の xl(1280px)ブレークポイント以上。 */
const DESKTOP = { width: 1440, height: 900 };
/** §3 「iPhone等の狭い画面」。既存のモバイルE2Eと同じ代表値。 */
const IPHONE = { width: 390, height: 844 };
/** ブレークポイントの直前。ここではまだ1カラムであることを確かめる。 */
const TABLET = { width: 1024, height: 768 };

async function signIn(page: Page) {
  await page.context().addCookies([
    { name: "__inv_e2e_role", value: `ADMIN:${E2E_TOKEN}`, url: "http://127.0.0.1:3100" },
  ]);
}

async function assertNoHorizontalOverflow(page: Page, context: string) {
  const overflow = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.docScrollWidth,
    `${context}: document.scrollWidth(${overflow.docScrollWidth}) > clientWidth(${overflow.docClientWidth}) — 横スクロールが発生している`,
  ).toBeLessThanOrEqual(overflow.docClientWidth);
}

const panel = (page: Page) => page.getByRole("complementary", { name: "在庫詳細・基本情報" });
const description = (page: Page) => page.getByLabel("説明文");
const shippingMethod = (page: Page) => page.getByLabel("配送方法");

test.describe("EC出品画面のレイアウト", () => {
  test("PC幅: 右側に在庫詳細が表示され、出品フォームと2カラムになる", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(LISTING_URL);
    await expect(page.getByRole("heading", { name: "EC出品" })).toBeVisible();

    await expect(panel(page)).toBeVisible();

    // §2 「出品作業側を十分広く確保」。フォームが右パネルより広いこと、
    // かつ右パネルがフォームの**右側**にあること(下へ回っていないこと)を
    // 実測する。CSSクラス名ではなく実際の座標で確かめる。
    const formBox = (await page.getByText("出品下書き（共通項目）").boundingBox())!;
    const panelBox = (await panel(page).boundingBox())!;
    expect(panelBox.x, "右パネルは出品フォームの右側にある").toBeGreaterThan(formBox.x);
    expect(panelBox.y, "右パネルは出品フォームと同じ高さから始まる(下へ回っていない)").toBeLessThan(formBox.y + 200);

    // §2-1 表示すべき情報が実際に出ていること。
    for (const label of ["商品名", "カテゴリ", "在庫ステータス", "座面寸法", "材質", "らくらく家財便", "佐川急便サイズ"]) {
      await expect(panel(page).getByText(label, { exact: true }), `右パネルに「${label}」が出る`).toBeVisible();
    }
    // §6-1 座面寸法はZAICOの実データ形式から読めていること。
    await expect(panel(page).getByText("幅46×奥行41×高さ46.5cm")).toBeVisible();

    await assertNoHorizontalOverflow(page, "PC幅のEC出品画面");
  });

  test("iPhone幅: 右側の在庫詳細を表示しない(下へも回さない)", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.setViewportSize(IPHONE);
    await page.goto(LISTING_URL);
    await expect(page.getByRole("heading", { name: "EC出品" })).toBeVisible();

    // §3 「右側の在庫詳細・基本情報自体を非表示に」。
    await expect(panel(page)).toBeHidden();

    // 出品フォームは従来どおり使える。
    await expect(page.getByText("出品下書き（共通項目）")).toBeVisible();
    await expect(description(page)).toBeVisible();

    await assertNoHorizontalOverflow(page, "iPhone幅のEC出品画面");
  });

  test("タブレット幅(1024px): まだ1カラム(右パネルを潰さない)", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.setViewportSize(TABLET);
    await page.goto(LISTING_URL);
    await expect(page.getByRole("heading", { name: "EC出品" })).toBeVisible();
    await expect(panel(page)).toBeHidden();
    await assertNoHorizontalOverflow(page, "タブレット幅のEC出品画面");
  });

  test("説明文: 初期高さが約4倍で、ユーザーがリサイズできる", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(LISTING_URL);
    await expect(description(page)).toBeVisible();

    // §1-1 初期高さ。rows=16(従来は4)。行数で確かめると、フォントや
    // paddingの変更に引きずられずに「4倍にした」ことだけを固定できる。
    await expect(description(page)).toHaveAttribute("rows", "16");

    // 実際の描画高さも見る。1行あたり最低16pxとして4行なら64px程度、
    // 16行なら250px以上になるはず —— rows属性がCSSに打ち消されていないこと。
    const box = (await description(page).boundingBox())!;
    expect(box.height, `説明文の初期高さ(${box.height}px)が4行相当のままになっていない`).toBeGreaterThan(200);

    // §1-1 リサイズ機能は維持する。縦は可、横は不可(2カラムを壊さない)。
    const resize = await description(page).evaluate((el) => getComputedStyle(el).resize);
    expect(resize, "説明文を縦方向にリサイズできる").toBe("vertical");
  });

  /**
   * 2026-09-04 追加指示 §1: 配送方法の選択。
   *
   * 「らくらく家財便が既定で、必要な商品だけ佐川へ変える」という運用を
   * 画面で実際に確かめる。切り替えたときに他の入力が消えないことまで見る
   * ——選択の付け替えでタイトルや説明文が飛ぶと、担当者は二度と触らない。
   */
  test("配送方法: 既定はらくらく家財便で、佐川急便へ切り替えて戻せる", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(LISTING_URL);
    await expect(shippingMethod(page)).toBeVisible();

    // 開いた時点での既定。
    await expect(shippingMethod(page)).toHaveValue("KAZAI");
    await expect(page.getByText("既存の送料計算と同じらくらく家財便のランクを入れます", { exact: false })).toBeVisible();

    // 他の入力を埋めてから切り替え、消えないことを見る。
    const titleBefore = await page.getByLabel("出品タイトル").inputValue();
    await description(page).fill("担当者が書いた説明文");

    await shippingMethod(page).selectOption("SAGAWA");
    await expect(shippingMethod(page)).toHaveValue("SAGAWA");
    await expect(page.getByText("3辺合計＋20cmで判定した佐川急便のサイズを入れます", { exact: false })).toBeVisible();
    await expect(description(page)).toHaveValue("担当者が書いた説明文");
    await expect(page.getByLabel("出品タイトル")).toHaveValue(titleBefore);

    // 戻せる。
    await shippingMethod(page).selectOption("KAZAI");
    await expect(shippingMethod(page)).toHaveValue("KAZAI");
    await expect(description(page)).toHaveValue("担当者が書いた説明文");
  });

  test("配送方法: iPhone幅でも操作できる", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.setViewportSize(IPHONE);
    await page.goto(LISTING_URL);
    await expect(shippingMethod(page)).toBeVisible();
    await expect(shippingMethod(page)).toHaveValue("KAZAI");
    await shippingMethod(page).selectOption("SAGAWA");
    await expect(shippingMethod(page)).toHaveValue("SAGAWA");
    await assertNoHorizontalOverflow(page, "iPhone幅で配送方法を切り替えた後");
  });

  test("長文を入れてもレイアウトが崩れない", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(LISTING_URL);

    // §4 の構成で生成した本文と同程度の長さ(約2,000字)を入れる。
    const long = Array.from({ length: 40 }, (_, i) => `◎セクション${i} これは長文入力時のレイアウト確認用の行です。`).join("\n");
    await description(page).fill(long);
    await expect(page.getByText(`${long.length.toLocaleString("ja-JP")}文字`)).toBeVisible();

    await assertNoHorizontalOverflow(page, "長文入力後のEC出品画面");
    // 右パネルが押し出されていないこと。
    await expect(panel(page)).toBeVisible();
  });
});
