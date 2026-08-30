import { test, expect } from "@playwright/test";

/**
 * 不具合修正・ZAICO同期重複根絶・EC出品UI改善・画像自動加工 完全自律
 * 実装指示書(2026-08-30) §7: 在庫一覧のチェックボックスに実際の用途
 * (選択した商品の画像を一括自動加工)を与えた——「チェックしたのに
 * 何も起こらないUIは禁止」の再発防止テスト。実際のブラウザで
 * チェックボックスの状態遷移・ボタンの表示条件を検証する
 * (e2e/inventory-mobile.spec.tsと同じfixture認証、デスクトップ幅で
 * 実行 — チェックボックス列はInventoryTable.tsx側のみに存在し、
 * モバイル幅のInventoryCardListには意図的に持ち込んでいない)。
 *
 * 実際の画像加工予約(AWSへの書き込み)自体はfixtureモードの対象外
 * (書き込み系には適用しない、既存の安全設計)のため、ボタンを押した
 * 後に実際にAWSへ書き込めるかは検証しない——ここで検証するのは
 * 「チェックボックスの選択状態がUIへ正しく反映される」
 * 「選択件数に応じてボタンの表示/非表示が切り替わる」という、
 * 以前は存在しなかった実際のUI配線そのもの。
 */
test.use({ viewport: { width: 1280, height: 900 } });

async function signInAsE2EFixtureRole(page: import("@playwright/test").Page) {
  const token = "e2e-local-test-token-not-a-real-secret-32c";
  await page.context().addCookies([
    {
      name: "__inv_e2e_role",
      value: `ADMIN:${token}`,
      url: "http://127.0.0.1:3100",
    },
  ]);
}

test("在庫一覧のチェックボックスが実際に選択状態を持ち、選択件数に応じて一括画像加工ボタンが現れる", async ({ page }) => {
  await signInAsE2EFixtureRole(page);
  await page.goto("/inventory");
  // 1280px幅では、InventoryCardList(モバイル専用、md:hidden)は常に
  // DOM上に存在し続ける(非表示なだけ)——page全体からgetByTextで
  // 検索すると、実際に見えているデスクトップ表(InventoryTable)より
  // 先にDOM順でこの非表示要素にマッチしてしまう(e2e/inventory-mobile.spec.ts
  // が同じ文言で.first()を使えているのはモバイル幅でテストしている
  // ため、そちらは逆にカード側が可視)。デスクトップ幅のこのテストでは
  // 表(table)側に明示的にスコープする。
  await expect(page.locator("table tbody").getByText("北欧デザインダイニングチェア").first()).toBeVisible({ timeout: 30_000 });

  // 初期状態: 何も選択していないので一括ボタンは表示されない。
  await expect(page.getByRole("button", { name: "選択した商品の画像を一括自動加工" })).toHaveCount(0);

  // 1行目のチェックボックスを選択する。
  const firstRowCheckbox = page.locator('tbody input[type="checkbox"]').first();
  await firstRowCheckbox.check();
  await expect(firstRowCheckbox).toBeChecked();
  await expect(page.getByText("1件選択中")).toBeVisible();
  await expect(page.getByRole("button", { name: "選択した商品の画像を一括自動加工" })).toBeVisible();

  // チェックを外すとボタンが再び消える(「チェックしたのに何も
  // 起こらない」の逆——「外したのに残り続ける」という不具合も無い
  // ことを確認する)。
  await firstRowCheckbox.uncheck();
  await expect(page.getByRole("button", { name: "選択した商品の画像を一括自動加工" })).toHaveCount(0);

  // 「すべて選択」ヘッダーチェックボックスで全行を選択できる。
  const headerCheckbox = page.locator('thead input[type="checkbox"]').first();
  await headerCheckbox.check();
  const rowCheckboxes = page.locator('tbody input[type="checkbox"]');
  const rowCount = await rowCheckboxes.count();
  expect(rowCount).toBeGreaterThan(0);
  for (let i = 0; i < rowCount; i++) {
    await expect(rowCheckboxes.nth(i)).toBeChecked();
  }
  await expect(page.getByText(`${rowCount}件選択中`)).toBeVisible();

  // 全解除。
  await headerCheckbox.uncheck();
  for (let i = 0; i < rowCount; i++) {
    await expect(rowCheckboxes.nth(i)).not.toBeChecked();
  }
  await expect(page.getByRole("button", { name: "選択した商品の画像を一括自動加工" })).toHaveCount(0);
});
