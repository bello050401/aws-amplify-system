import { test, expect, type Page } from "@playwright/test";

/**
 * 売上予測候補b2b385f(異常日時と表示整合、2026-09-15)の実ブラウザQA。
 *
 * ── なぜ実集計テーブルを直接見に行かないか ──────────────────────────
 *
 * このsandbox環境には実AWS(AppSync)への到達経路が無く、かつ「前日21時
 * snapshotを翌朝に見る」「rebuiltAtが不正/未来」という異常系を実データで
 * 再現するには本番集計テーブルへの直接書き込みが要る——実DB・実集計
 * ロジックには一切触れない、というこのタスクの制約と両立しない。
 *
 * lib/inventory/salesE2eFixtures.tsが提供する完全合成SalesSummaryView
 * だけを表示する(常に実SDKへ到達しない——scripts/verify-sales-summary-
 * e2e-isolation.tsで到達ゼロを別途証明済み)。データはfixtureモード二重
 * ゲート(isE2EFixtureModeActive、playwright.config.tsのwebServer.envで
 * INVENTORY_E2E_FIXTURES=1を設定)——実AWSへは一切到達しない。シナリオ
 * 切替はCookie(`__inv_e2e_sales_scenario`)——lib/inventory/
 * zaicoSyncE2eFixtures.tsの`__inv_e2e_zaico_scenario`と同じ発想。
 *
 * ── 「今日」を差し替えられない制約への対応 ───────────────────────────
 *
 * page.tsx自体の`new Date()`(JSTでの「今」の判定基準)は差し替えていない
 * ——fixtureはaggregateRebuiltAt側を実行時点のJST「前日21時」から動的に
 * 組み立てる(lib/inventory/salesE2eFixtures.tsのyesterdayJst21IsoRelativeTo
 * 参照)。このspecも同じ計算をここで再現し、実行日に依存しない期待値を
 * 都度算出する——月初(1日)に実行すると前日が前月へ繰り上がり
 * (forecastReferenceDayがdifferent-monthを返す)、正常シナリオでも
 * 着地予測が出ない側に倒れる——これも異常系の1つとして扱い、その場合は
 * forecastUnavailableの検証へ自動的に分岐する(テストが恒常的に赤くなる
 * ことはない)。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
// playwright.config.tsと同じE2E_PORT上書き(他worktree/セッションの
// next devとのポート衝突回避、task_f712cf24a9fe2308cd)。addCookiesの
// urlはoriginが完全一致しないと効かないため、ポートを変えて走らせる
// ときはここも追従させる必要がある。
const E2E_PORT = process.env.E2E_PORT ?? "3100";
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
const SALES_URL = "/inventory/sales";

async function signInAsAdmin(page: Page, scenario?: "invalid" | "future") {
  const cookies = [{ name: "__inv_e2e_role", value: `ADMIN:${E2E_TOKEN}`, url: E2E_BASE_URL }];
  if (scenario) {
    cookies.push({ name: "__inv_e2e_sales_scenario", value: scenario, url: E2E_BASE_URL });
  }
  await page.context().addCookies(cookies);
}

/** lib/inventory/sales.tsのnowInJstと同じ計算(このファイルだけの目的で再現)。 */
function jstParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const get = (t: "year" | "month" | "day") => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** lib/inventory/salesE2eFixtures.tsのyesterdayJst21IsoRelativeToと同じ計算。 */
function yesterdayJstParts(now: Date): { year: number; month: number; day: number } {
  const t = jstParts(now);
  const rebuiltAt = new Date(Date.UTC(t.year, t.month - 1, t.day - 1, 12, 0));
  return jstParts(rebuiltAt);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

/**
 * 「売上高」というテキストは(a)SummaryTileのラベル(<p>)だけでなく
 * (b)直近12ヶ月推移グラフの凡例トグル(<span>)・各点のtitle属性("2025年
 * 10月: 売上高 ¥800,000 / 粗利益 ¥384,000"等)にも登場するため、
 * 素の`getByText("売上高")`はstrict mode違反になる(実測)。SummaryTileの
 * ラベルは唯一テキストが完全一致する<p>要素なので、それだけをXPathの
 * 完全一致(normalize-space)で一意に特定する。
 */
function salesTotalLabel(page: Page) {
  return page.locator("xpath=//p[normalize-space(text())='売上高']");
}

/**
 * SummaryTileの値(<p class="...tabular-nums...">¥2,407,020</p>)を一意に
 * 特定する——同じ金額文字列が直近12ヶ月推移グラフの各点title属性
 * ("2026年9月: 売上高 ¥2,407,020 / 粗利益 ¥...")にも部分文字列として
 * 登場しうるため、素の`getByText(..., {exact:false})`はstrict mode
 * 違反になりうる(実測)。SummaryTileの値は完全一致の<p>要素なので、
 * salesTotalLabelと同じXPath完全一致で特定する。
 */
function summaryValueText(page: Page, text: string) {
  return page.locator(`xpath=//p[normalize-space(text())='${text}']`);
}

const TOTAL_SALES = 2_407_020;

test.describe("売上画面(正常/不正/未来snapshot・過去月の合成QA表示)", () => {
  test("正常シナリオ: 前日snapshotを基準にした日数ラベル・平均・着地予測が一致する", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsAdmin(page);
    await page.goto(SALES_URL);

    const now = new Date();
    const cur = jstParts(now);
    const yesterday = yesterdayJstParts(now);

    // ★要件: 売上本体は常に表示される(予測の有無に関係なく)。
    await expect(salesTotalLabel(page)).toBeVisible();
    await expect(summaryValueText(page, yen(TOTAL_SALES))).toBeVisible();

    if (yesterday.year === cur.year && yesterday.month === cur.month) {
      // 正常系: 前日のJST日が当月内 → forecastReferenceDayはok:trueを返す想定。
      const totalDaysInMonth = daysInMonth(cur.year, cur.month);
      const elapsedDays = yesterday.day;
      const averageDailySales = TOTAL_SALES / elapsedDays;
      const projectedMonthEndSales = averageDailySales * totalDaysInMonth;

      // 「今月の売上着地予測」というテキストは見出し<p>とSummaryTileの
      // ラベル<p>の2箇所に登場する(page.tsx参照)——存在確認だけなので
      // .first()で十分。
      await expect(page.getByText("今月の売上着地予測").first()).toBeVisible();
      await expect(page.getByText(`${yen(averageDailySales)} / 日`, { exact: false })).toBeVisible();
      await expect(summaryValueText(page, yen(projectedMonthEndSales))).toBeVisible();
      await expect(page.getByText(`${cur.month}月${elapsedDays}日時点 / ${totalDaysInMonth}日間`, { exact: false })).toBeVisible();
      await expect(page.getByText("集計日時を確認できないため", { exact: false })).toHaveCount(0);
    } else {
      // 月初(1日)にこのテストを実行した場合の既知の境界——前日が前月へ
      // 繰り上がりdifferent-monthとなる(異常系の1つ、赤ではなく分岐)。
      await expect(page.getByText("集計日時を確認できないため", { exact: false })).toBeVisible();
    }
  });

  test("不正シナリオ: 集計日時が不正でも着地予測は出ず、売上本体は維持される", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsAdmin(page, "invalid");
    await page.goto(SALES_URL);

    // ★要件: 売上本体(実績)は影響を受けない。
    await expect(salesTotalLabel(page)).toBeVisible();
    await expect(summaryValueText(page, yen(TOTAL_SALES))).toBeVisible();

    // ★要件: 着地予測の数字は出ない——理由だけの簡潔な文言に置き換わる。
    await expect(page.getByText("今月の売上着地予測")).toBeVisible(); // ラベル自体は出る(不可の説明として)
    await expect(page.getByText("集計日時を確認できないため、着地予測は算出できません", { exact: false })).toBeVisible();
    await expect(page.getByText("1日平均売上")).toHaveCount(0);
  });

  test("未来シナリオ: 集計日時が閲覧時刻より未来でも着地予測は出ず、売上本体は維持される", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsAdmin(page, "future");
    await page.goto(SALES_URL);

    await expect(salesTotalLabel(page)).toBeVisible();
    await expect(summaryValueText(page, yen(TOTAL_SALES))).toBeVisible();

    await expect(page.getByText("集計日時を確認できないため、着地予測は算出できません", { exact: false })).toBeVisible();
    await expect(page.getByText("1日平均売上")).toHaveCount(0);
  });

  test("過去月: シナリオCookieに関係なく着地予測欄自体が出ない(売上本体は表示される)", async ({ page }) => {
    test.setTimeout(90_000);
    // 現在月なら異常表示になるはずのシナリオを立てたまま前月へ移動しても、
    // 過去月は着地予測の対象外(isCurrentJstYearMonth=false)——
    // シナリオの効果自体が及ばないことを確認する。
    await signInAsAdmin(page, "future");
    await page.goto(SALES_URL);
    await page.getByRole("link", { name: "先月" }).click();

    await expect(salesTotalLabel(page)).toBeVisible();
    // 過去月は集計が"ok"の合成値を返すため"—"にはならない。
    await expect(page.getByText("—", { exact: true })).toHaveCount(0);

    // ★要件: 着地予測欄(数字/不可メッセージのどちらも)がそもそも出ない。
    await expect(page.getByText("今月の売上着地予測")).toHaveCount(0);
    await expect(page.getByText("集計日時を確認できないため", { exact: false })).toHaveCount(0);
  });
});
