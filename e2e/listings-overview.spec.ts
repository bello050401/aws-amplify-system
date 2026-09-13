import { test, expect, type Page } from "@playwright/test";

/**
 * EC一覧P1 レビュー補正(2026-09-13)の実ブラウザ検証。
 *
 * タスク指示書§7「実React一覧364件以上、初回/再訪/検索/状態絞込/
 * ページ移動/選択維持。5秒遅延とread rejection→局所復帰、データ不明の
 * 一括禁止」に対応する。
 *
 * データは lib/listing/e2eFixtures.ts の固定fixture(364件)——
 * lib/inventory/e2eFixtures.ts と同じ二重ゲート
 * (INVENTORY_E2E_FIXTURES=1 かつ NODE_ENV!=='production')の内側だけで
 * 有効になり、実AWSには一切到達しない(playwright.config.tsのwebServer
 * が起動する`next dev`にだけこの環境変数を渡している)。
 *
 * このfixtureは「dev serverプロセス内での呼び出し回数」で挙動を変える
 * (lib/inventory/e2eFixtures.tsのe2e-inv-8と同じ設計):
 *   1回目の呼び出し(=このファイルの最初のテストの初回navigation) は
 *   必ず失敗し、2回目以降は5秒遅延の後に364件を返す。そのため
 *   「初回失敗→再試行で成功」を検証するテストを本ファイルの先頭に置き、
 *   以降のテストは(別の呼び出しになるため)5秒遅延はあるが必ず成功する。
 *
 * 認証はe2e/listing-layout.spec.tsと同じ`__inv_e2e_role`Cookie。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
const LISTINGS_URL = "/inventory/listings";
const TOTAL_ROWS = 364;
const NOT_STARTED_COUNT = 20;
const DRAFT_COUNT = 20;
// playwright.config.tsの既定は3100だが、この一覧harnessだけ別ポートで
// 単発実行できるようにしてある(他worktreeが3100を使用中の場合の回避策)。
const BASE_URL = process.env.E2E_LISTINGS_BASE_URL ?? "http://127.0.0.1:3100";

async function signIn(page: Page, role: "ADMIN" | "VIEWER" = "ADMIN") {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `${role}:${E2E_TOKEN}`, url: BASE_URL }]);
}

const heading = (page: Page) => page.getByRole("heading", { name: "EC出品" });
// 2026-09-14 指示書「Mercari API不可の運用と案内を一致させる」対応:
// EXTERNAL_WRITES_ENABLED未設定(既定fail-closed、このE2E harnessの
// webServerも設定していない)では、app/inventory/(protected)/listings/
// page.tsxの案内文は「在庫の商品についてMercari Shops向けの出品準備...」
// (manual-only文言)へ分岐する——以前の「在庫の商品をMercari Shopsへ
// 出品する状況を...」は書き込みが許可されている場合のみ出る分岐に
// なった。ここでは両分岐に共通する冒頭部分だけを見て、「一覧データ
// 取得を待たずに案内文が先に描画される」という本来の検証意図を保つ。
const guidance = (page: Page) => page.getByText("在庫の商品について", { exact: false });
// Next.jsのroute announcer(__next-route-announcer__)も常時role="alert"
// を持つため、getByRole("alert")だけだと2要素にヒットする(strict mode
// violation、実測)。テキストで直接絞り込む。
const errorAlert = (page: Page) => page.getByText("EC出品一覧を読み込めませんでした。");
const retryButton = (page: Page) => page.getByRole("button", { name: "再試行" });
const countBadge = (page: Page) => page.getByText(/件表示$/);
const searchBox = (page: Page) => page.getByPlaceholder("商品名・在庫IDで絞り込み");
const statusSelect = (page: Page) => page.locator("select");
const nextPageButton = (page: Page) => page.getByRole("button", { name: "次へ →" });
const prevPageButton = (page: Page) => page.getByRole("button", { name: "← 前へ" });
const selectAllCheckbox = (page: Page) => page.getByLabel("すべて選択");
const bulkCreateButton = (page: Page) => page.getByRole("button", { name: /出品下書きを一括作成/ });

test.describe("EC出品一覧(/inventory/listings)", () => {
  test("初回読み込み失敗→ヘッダーは即描画・一括操作なし→再試行で364件表示", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto(LISTINGS_URL);

    // ヘッダー・案内文は一覧データ取得(1回目=必ず失敗)を待たずに描画される
    // (Suspense境界の外——page.tsxの修正の核心)。
    await expect(heading(page)).toBeVisible();
    await expect(guidance(page)).toBeVisible();

    // 一覧側は「0件」ではなくエラー+再試行導線になる。
    await expect(errorAlert(page)).toHaveText("EC出品一覧を読み込めませんでした。");
    await expect(retryButton(page)).toBeVisible();
    // データ不明の間、一括作成ボタンはそもそもDOMに存在しない
    // (state.kind!=="ok"の分岐がボタン列自体を描画しない)。
    await expect(bulkCreateButton(page)).toHaveCount(0);

    await retryButton(page).click();
    await expect(page.getByText("読み込み中…")).toBeVisible();
    // 2回目の呼び出しは5秒遅延の後に成功する。
    await expect(countBadge(page)).toHaveText(`${TOTAL_ROWS.toLocaleString("ja-JP")}件表示`, { timeout: 15_000 });
  });

  test("検索・状態絞込・ページ移動・選択維持", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto(LISTINGS_URL);
    // このnavigationは(ファイル内で)2回目以降の呼び出しなので5秒遅延の後に成功する。
    await expect(countBadge(page)).toHaveText(`${TOTAL_ROWS.toLocaleString("ja-JP")}件表示`, { timeout: 15_000 });

    // ── 検索: 一意な名前を持つ1件だけに絞り込める ──
    await searchBox(page).fill("検索対象サンプルチェアA");
    await expect(countBadge(page)).toHaveText("1件表示");
    await expect(page.getByRole("link", { name: "検索対象サンプルチェアA" })).toBeVisible();
    await searchBox(page).fill("");
    await expect(countBadge(page)).toHaveText(`${TOTAL_ROWS.toLocaleString("ja-JP")}件表示`);

    // ── 状態絞込: 「下書き」バケット(実測47件——channelListing無し・
    // hasDraft=trueの20件 + channelListing.status==="DRAFT"の27件が
    // どちらも同じ「下書き」ラベルに集約される、statusOf()の仕様どおり)。 ──
    await statusSelect(page).selectOption({ label: "下書き" });
    await expect(countBadge(page)).toHaveText(`${DRAFT_COUNT + 27}件表示`);
    // 配列順が保たれるため先頭行はchannelListing無し・hasDraft=trueの
    // バケット——一括作成の対象外なのでチェックボックスは無効。
    await expect(page.locator("tbody tr").first().locator('input[type="checkbox"]')).toBeDisabled();

    // ── 選択維持: 未着手行を選択したまま絞り込み条件を変えても選択が保たれる ──
    await statusSelect(page).selectOption({ label: "未着手" });
    await expect(countBadge(page)).toHaveText(`${NOT_STARTED_COUNT}件表示`);
    const firstRowCheckbox = page.locator("tbody tr").first().locator('input[type="checkbox"]');
    await firstRowCheckbox.check();
    await expect(page.getByText("1件選択中")).toBeVisible();
    await statusSelect(page).selectOption({ label: "すべて" });
    await expect(countBadge(page)).toHaveText(`${TOTAL_ROWS.toLocaleString("ja-JP")}件表示`);
    // 絞り込みを解除しても選択件数は変わらない(選択対象はfiltered全体のinventoryId setで管理されている)。
    await expect(page.getByText("1件選択中")).toBeVisible();

    // ── ページ移動: 「次へ」でページ内容が変わり、「前へ」で戻れる ──
    const firstPageFirstRowText = await page.locator("tbody tr").first().innerText();
    await expect(nextPageButton(page)).toBeEnabled();
    await nextPageButton(page).click();
    await expect(page.getByText("2 / ")).toBeVisible();
    const secondPageFirstRowText = await page.locator("tbody tr").first().innerText();
    expect(secondPageFirstRowText).not.toBe(firstPageFirstRowText);
    // 選択は他ページへ移動しても保持される。
    await expect(page.getByText("1件選択中")).toBeVisible();
    await prevPageButton(page).click();
    await expect(selectAllCheckbox(page)).not.toBeChecked(); // 全選択ではなく1件だけ選択中のまま
    await expect(page.getByText("1件選択中")).toBeVisible();
  });

  test("VIEWER権限では一括操作の導線が出ない(閲覧は可能)", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page, "VIEWER");
    await page.goto(LISTINGS_URL);
    await expect(countBadge(page)).toHaveText(`${TOTAL_ROWS.toLocaleString("ja-JP")}件表示`, { timeout: 15_000 });
    await expect(bulkCreateButton(page)).toHaveCount(0);
    await expect(selectAllCheckbox(page)).toHaveCount(0);
  });
});
