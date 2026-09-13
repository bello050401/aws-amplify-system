import { test, expect, type Page } from "@playwright/test";

/**
 * 2026-09-14 指示書レビュー: 設定画面(/inventory/settings)のPlaywright
 * E2E。3つの目的:
 *
 *   1. `?tab=mercari`の直リンクが実UIのuseStateへ正しく反映されること
 *      (SettingsTabs.tsxの既存バグ修正 — 以前は"base"以外のtab値を
 *      無視して既定タブ(カテゴリ)へ落ちていた)。
 *   2. EC出品（Mercari）タブがmanual-only運用の状態(「停止中（手動出品
 *      のみ）」)を正しく表示すること — TOKEN保存/接続確認(verified)と
 *      「実際にAPI送信してよいか」を混同しない。
 *   3. BASE連携タブが実際の「接続済み」画面を表示すること(§9「BASEも
 *      実際の接続画面が出ることを確認」)——BASEはMercariと違い実接続
 *      可能な機能なので、退行させていないことをここで確かめる。
 *
 * データはlib/inventory/masters.ts等の各E2E fixture分岐(fixtureモード
 * 二重ゲート、isE2EFixtureModeActive)——実AWSへは一切到達しない
 * (境界の証明はscripts/verify-settings-e2e-isolation.ts側)。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
const SETTINGS_URL = "/inventory/settings";

async function signIn(page: Page) {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${E2E_TOKEN}`, url: "http://127.0.0.1:3100" }]);
}

const mercariTabButton = (page: Page) => page.getByRole("button", { name: "EC出品（Mercari）" });
const baseTabButton = (page: Page) => page.getByRole("button", { name: "BASE連携" });

test.describe("設定画面(/inventory/settings)", () => {
  test("?tab=mercariの直リンクでEC出品（Mercari）タブが最初から開く", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto(`${SETTINGS_URL}?tab=mercari`);
    await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();

    // ★要件: 以前はここが黙って既定タブ(カテゴリ)のまま描画されていた。
    await expect(page.getByText("Mercariへの出品（API送信）:")).toBeVisible();
    await expect(mercariTabButton(page)).toHaveClass(/border-gray-900/);
  });

  test("EC出品（Mercari）タブ: TOKEN保存・接続確認済みでも、この運用ではAPI送信が「停止中」と表示される", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto(SETTINGS_URL);
    await mercariTabButton(page).click();

    // ★要件: manual-only運用の核心 — verified(接続確認済み)であっても
    // 「TOKENを設定すれば出品できる」という誤案内をしない。
    await expect(page.getByText("現在の運用ではMercariへの自動出品（API送信）自体を行っておらず", { exact: false })).toBeVisible();
    await expect(page.getByText("Mercariへの出品（API送信）:")).toBeVisible();
    await expect(page.getByText("停止中（手動出品のみ）")).toBeVisible();
  });

  test("BASE連携タブ: 実際の「接続済み」画面が表示される(BASEは維持)", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto(`${SETTINGS_URL}?tab=base`);

    // ★要件(§9): BASEはMercariと違い実接続可能な機能——manual-only化の
    // 影響を受けず、実際の接続済み画面がそのまま出ることを確認する。
    await expect(baseTabButton(page)).toHaveClass(/border-gray-900/);
    await expect(page.getByText("接続済み。特集ページ作成機能と商品説明分析機能は、この同じ接続を共用します", { exact: false })).toBeVisible();
  });

  test("タブをクリックして切り替えても状態が保たれる(カテゴリ→Mercari→BASE→Mercari)", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto(SETTINGS_URL);

    // 既定タブはカテゴリ。exact指定が要る——「カテゴリ」だけだとMasterList
    // 側の「カテゴリを追加」等のボタンも部分一致してstrict mode違反になる
    // (実測)。
    await expect(page.getByRole("button", { name: "カテゴリ", exact: true })).toHaveClass(/border-gray-900/);

    await mercariTabButton(page).click();
    await expect(page.getByText("Mercariへの出品（API送信）:")).toBeVisible();

    await baseTabButton(page).click();
    await expect(page.getByText("接続済み。", { exact: false })).toBeVisible();

    await mercariTabButton(page).click();
    await expect(page.getByText("Mercariへの出品（API送信）:")).toBeVisible();
  });
});
