import { test, expect, type Page } from "@playwright/test";

/**
 * ZAICO候補3b3b8cd(持ち越し再試行/復旧スキャンの基準固着修正)の
 * 実ブラウザQA。
 *
 * ── なぜ実ジョブ行を直接見に行かないか ─────────────────────────────
 *
 * ZaicoSyncPanel.tsxはマウント時に同期状態を取得し、PENDING/RUNNINGで
 * あれば即座に「1ページ進める」(実ZAICO API呼び出し)へ進む設計——
 * 実ジョブ行をそのまま画面に出すと、開いただけで実際の同期が進みかねない。
 * このspecはlib/inventory/zaicoSyncE2eFixtures.tsが提供する合成
 * COMPLETEDジョブだけを表示する(常にCOMPLETEDなので自動advanceは
 * 構造的に発火しない——scripts/verify-zaico-sync-e2e-isolation.tsで
 * SDK到達ゼロを別途証明済み)。
 *
 * データはfixtureモード二重ゲート(isE2EFixtureModeActive、
 * playwright.config.tsのwebServer.envでINVENTORY_E2E_FIXTURES=1を設定)
 * ——実AWSへは一切到達しない。シナリオ切替はCookie
 * (`__inv_e2e_zaico_scenario`)——lib/amplify/requireInventoryUser.tsの
 * `__inv_e2e_role`と同じ発想。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
const SETTINGS_URL = "/inventory/settings";

async function signInAsAdmin(page: Page, scenario?: "delta" | "recovery") {
  const cookies = [{ name: "__inv_e2e_role", value: `ADMIN:${E2E_TOKEN}`, url: "http://127.0.0.1:3100" }];
  if (scenario) {
    cookies.push({ name: "__inv_e2e_zaico_scenario", value: scenario, url: "http://127.0.0.1:3100" });
  }
  await page.context().addCookies(cookies);
}

const zaicoTabButton = (page: Page) => page.getByRole("button", { name: "ZAICO同期" });

test.describe("設定画面 > ZAICO同期タブ(合成COMPLETEDジョブのQA表示)", () => {
  test("差分同期(delta): 差分基準日時・持ち越し再試行1件が表示される", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsAdmin(page, "delta");
    await page.goto(`${SETTINGS_URL}?tab=zaico`);
    await zaicoTabButton(page).click();

    // ★要件: マウントしただけで実同期が進まない(常にCOMPLETED)——
    // 「実行中…」表示にならないことを確認する。
    await expect(page.getByText("実行中…", { exact: false })).toHaveCount(0);

    // ★要件: 種類=差分同期、かつ具体的な差分基準日時が出る(「初回または
    // 復旧時」という汎用文言ではない)。
    await expect(page.getByText("差分同期")).toBeVisible();
    await expect(page.getByText("差分の基準確認・未処理商品の再確認のため全件を対象", { exact: false })).toHaveCount(0);

    // ★要件: 持ち越し再試行(恒久失敗の強制再試行)が1件表示される。
    await expect(page.getByText("持ち越し再試行")).toBeVisible();
    await expect(page.getByText("1件前回以前から同期に失敗し続けている商品です", { exact: false })).toHaveCount(0); // 隣接テキストの結合誤りが無いことの軽い確認
    await expect(page.getByText("前回以前から同期に失敗し続けている商品です", { exact: false })).toBeVisible();

    // 差分スキップ件数も表示される(合成値: 5,265件)。
    await expect(page.getByText("差分スキップ")).toBeVisible();
    await expect(page.getByText("5,265件", { exact: false })).toBeVisible();
  });

  test("復旧スキャン(recovery): 復旧理由の文言が出て、初回(未経験)とは区別できる", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsAdmin(page, "recovery");
    await page.goto(`${SETTINGS_URL}?tab=zaico`);
    await zaicoTabButton(page).click();

    await expect(page.getByText("実行中…", { exact: false })).toHaveCount(0);

    // ★要件: syncSince=nullのときの復旧理由の文言が出る。
    await expect(page.getByText("差分の基準確認・未処理商品の再確認のため全件を対象（初回または復旧時）")).toBeVisible();

    // ★要件: 「初回と毎回表示を混同しない」— 詳細を開くと、真の初回
    // (一度も成功していない)なら出るはずの「まだ一度も完了していません」
    // ではなく、過去の実在時刻が「最終同期成功」に出る(=復旧であって
    // 真の初回ではないことが読み取れる)。
    await page.getByText("詳細").click();
    await expect(page.getByText("まだ一度も完了していません", { exact: false })).toHaveCount(0);
    await expect(page.getByText("最終同期成功")).toBeVisible();

    // 復旧回は持ち越し再試行が解消(0件)しているので、その行自体が出ない。
    await expect(page.getByText("持ち越し再試行")).toHaveCount(0);
  });

  test("ボタン操作はfixtureモードでは実際の同期を起動しない", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsAdmin(page, "delta");
    await page.goto(`${SETTINGS_URL}?tab=zaico`);
    await zaicoTabButton(page).click();

    // ★要件: 「通常同期する（差分）」を押しても、fixtureモードでは
    // 実際には開始されない旨のエラーメッセージが返るだけで、
    // 「実行中…」には遷移しない(lib/inventory/zaicoBackgroundSync.ts
    // のstartZaicoBackgroundSyncJobガード参照)。
    await page.getByRole("button", { name: "通常同期する（差分）" }).click();
    await expect(page.getByText("E2Eフィクスチャモードのため、実際の同期は開始されません", { exact: false })).toBeVisible();
    await expect(page.getByText("実行中…", { exact: false })).toHaveCount(0);
  });
});
