import { test, expect, type Page, type Download } from "@playwright/test";
import { decodeCp932 } from "../lib/listing/mercari/csv/cp932";
import { parseCsvIndependent } from "../lib/listing/mercari/csv/independentParse";

/**
 * CSV候補e0fe20760b7a3c2b926f03b58b0c94108b6680fb 不足項目編集→保存→CSV
 * 再生成 未検証の是正(task_48c715588f96367bc9、2026-09-15)。
 *
 * e2e/mercari-csv-image-download.spec.tsの旧冒頭コメントに記載していた
 * 既知の制約——「CSV編集補完」(カテゴリー/発送日数/配送料負担の選択・
 * 保存UI)は書き込み経路(saveChannelOverrideAction)を通るため実UIの
 * 対話自体を検証できない——を、lib/listing/service.tsのsaveChannelOverride
 * に追加した非本番合成境界(lib/listing/e2eFixtures.tsのe2eSaveChannelOverride
 * /e2eChannelOverrideFor)で埋める。ここでは実ブラウザ・実Next.jsサーバー
 * ・実Server Action(saveChannelOverrideAction)・実権限チェック
 * (requireEditPermission)を通して、「不足項目をUIで埋めて保存→再読込
 * しても値が保持される」「VIEWERは保存できない」「保存失敗時は入力が
 * 消えない」ことを検証する。数値の実際の一致(CSV再生成含む)は、この
 * sandboxで実ブラウザから直接叩けないServer Action経路の分だけ、
 * scripts/verify-mercari-csv-edit-save.tsが同じservice.ts関数を直接
 * 呼んで補完する(そちらは「SDK到達ゼロ」の実測も兼ねる)。
 *
 * webServer(playwright.config.ts)がINVENTORY_E2E_FIXTURES=1を渡すため、
 * 実AWSには一切到達しない。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
// task_302c7e3c24b575629d(2026-09-15是正): カテゴリーの新規選択は
// 「家具・インテリア」配下限定(MercariFurnitureCategoryPicker.tsx)に
// なった——このファイルのテストは既存のID配線(保存→再読込→CSV再生成)
// 自体の回帰確認が主目的で、以前は家具外の既知ID(K-POP)を全カテゴリ
// 自由文字列検索経由で選んでいたが、その検索導線自体が「新規選択は
// 家具限定」という要求と矛盾していたため削除された(MercariCategoryMappingSection.tsx
// 参照)。ここでは実在する家具カテゴリの既知ID(getCategoryById検証済み、
// e2e/mercari-furniture-category-picker.spec.tsと同じ値)へ差し替える
// ——検証したいのはID配線自体であって、家具かどうかは本題ではない。
const FURNITURE_CATEGORY_ID = "u9jzuziaZ4F9BeP8Dk3RwD";
const FURNITURE_CATEGORY_FULL_PATH = "家具・インテリア > ライト・照明 > シーリングライト・天井照明 > シーリングライト";
// playwright.config.tsと同じE2E_PORT上書き(他worktree/セッションの
// next devとのポート衝突回避、task_f712cf24a9fe2308cd)。addCookiesの
// urlはoriginが完全一致しないと効かないため、ポートを変えて走らせる
// ときはここも追従させる必要がある(e2e/listings-overview.spec.tsの
// BASE_URLと同じ理由)。
const E2E_PORT = process.env.E2E_PORT ?? "3100";
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

async function signIn(page: Page, role: "ADMIN" | "EDITOR" | "VIEWER" = "ADMIN") {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `${role}:${E2E_TOKEN}`, url: E2E_BASE_URL }]);
}

/** 「発送までの日数:」/「配送料の負担:」の直後のセクション内にあるselectだけを、ページ上の他のselect(コンディション・配送方法等)と取り違えずに特定する。 */
function sectionSelect(page: Page, headingText: string) {
  return page.locator("xpath=//p[contains(., $t)]/following-sibling::div[1]//select".replace("$t", `'${headingText}'`));
}

/**
 * 「発送までの日数:」/「配送料の負担:」の確定値サマリ(太字span、同じ
 * <p>内)だけを特定する。同じラベル文字列が<select>の<option>にも
 * 常に(選択されていなくても)存在するため、getByText(ラベル文字列)は
 * strict modeで複数要素にヒットして失敗する——サマリ用のspanだけへ
 * 絞り込む。
 */
function sectionSummary(page: Page, headingText: string) {
  return page.locator("xpath=//p[contains(., $t)]/span[contains(@class,'font-bold')]".replace("$t", `'${headingText}'`));
}

/**
 * 見出し文字列(例:「配送料の負担」「送料ID」)の直後のセクション内に
 * ある「保存」ボタンだけを特定する(task_ca862bd2a1f6fbf60d、
 * 2026-09-15追加)。送料別(配送料の負担=2)を選ぶと送料ID欄が動的に
 * 増えて「保存」ボタンの総数が変わるため、ページ全体からの
 * `getByRole("button",{name:"保存"}).nth(count-1)`(=最後のボタン)方式は
 * 送料IDセクションの有無で意味が変わってしまう——見出しに紐づけて
 * 特定することでその依存を無くす。sectionSelect/sectionSummaryと同じ
 * following-sibling::div[1]内を見る(inputかselectかは問わない)。
 */
function sectionSaveButton(page: Page, headingText: string) {
  return page.locator(
    "xpath=//p[contains(., $t)]/following-sibling::div[1]//button[normalize-space(text())='保存']".replace("$t", `'${headingText}'`),
  );
}

/** sectionSelectのinput版(送料IDは<select>ではなく自由入力の<input>のため)。 */
function sectionInput(page: Page, headingText: string) {
  return page.locator("xpath=//p[contains(., $t)]/following-sibling::div[1]//input".replace("$t", `'${headingText}'`));
}

/**
 * 家具ピッカー(MercariFurnitureCategoryPicker.tsx)の家具内検索から
 * 既知の家具カテゴリ(FURNITURE_CATEGORY_FULL_PATH)を選んで確定する。
 * 検索結果のクリックは経路への移動だけ(即確定しない)——「このカテゴリに
 * 決定」を押して初めて保存される、という実装方針を崩さないテストにする
 * (task_302c7e3c24b575629d、2026-09-15是正)。
 */
function furniturePicker(page: Page) {
  return page.getByTestId("mercari-furniture-category-picker");
}

async function selectFurnitureCategoryById(page: Page) {
  const picker = furniturePicker(page);
  await picker.getByPlaceholder("家具カテゴリ名で検索（家具・インテリア配下のみ）").fill("シーリングライト");
  await picker.getByRole("button", { name: FURNITURE_CATEGORY_FULL_PATH, exact: true }).click();
  await picker.getByRole("button", { name: "このカテゴリに決定" }).click();
}

async function downloadToBuffer(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream is null");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** e2e/mercari-csv-image-download.spec.tsのgotoListingsOverviewと同じ理由(初回失敗→再試行の決定的な吸収)。 */
async function gotoListingsOverview(page: Page) {
  await page.goto("/inventory/listings");
  const countBadge = page.getByText(/件表示$/);
  const retryButton = page.getByRole("button", { name: "再試行" });
  await Promise.race([countBadge.waitFor({ state: "visible", timeout: 15_000 }), retryButton.waitFor({ state: "visible", timeout: 15_000 })]);
  if (await retryButton.isVisible()) {
    await retryButton.click();
  }
  await expect(countBadge).toBeVisible({ timeout: 15_000 });
}

test.describe("Mercari CSV編集補完の実UI保存(saveChannelOverrideActionの非本番合成境界)", () => {
  test("不足項目(カテゴリー/発送日数/配送料負担)を実UIで埋めて保存→再読込しても値が保持される", async ({ page }) => {
    test.setTimeout(45_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-48/listing");
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("未確定（最終CSV出力がブロックされます。他の項目は先に保存できます）")).toBeVisible();

    await expect(sectionSummary(page, "発送までの日数")).toHaveCount(0);
    await expect(page.getByText("未設定（既定値「4〜7日で発送」を適用してCSV出力）")).toBeVisible();
    await expect(page.getByText("未設定（既定値「送料込（出品者負担）」を適用してCSV出力）")).toBeVisible();
    await expect(sectionSelect(page, "発送までの日数")).toHaveValue("3");
    await expect(sectionSelect(page, "配送料の負担")).toHaveValue("1");

    await selectFurnitureCategoryById(page);

    await expect(page.getByText("保存しました。")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`text=${FURNITURE_CATEGORY_ID}`)).toBeVisible();

    // ブランド検索(家具店向け効率化指示書(2026-09-15) §4-D是正、実UI検証)。
    // 「検索」ボタンを押さず入力だけで待つ——300msデバウンスの自動検索
    // (MercariCategoryMappingSection.tsxのrunBrandSearch)自体を検証する。
    // 実在する既知のブランド("Xmiss"、scripts/verify-mercari-csv-export.ts
    // のtestMastersと同じ値、外部APIへは一切到達しない)で検索する。
    await page.getByPlaceholder("ブランド名（和名/カナ/英語）で検索").fill("Xmiss");
    await expect(page.getByRole("button", { name: /^Xmiss/ })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /^Xmiss/ }).click();
    await expect(page.getByText("保存しました。")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Xmiss").first()).toBeVisible();

    // 発送までの日数
    // 「保存」ボタンはgetByRole({name})が既定で部分一致するため、exact指定
    // なしだと上部の「下書きを保存」ボタン(handleSaveDraft、この節とは
    // 無関係なsaveListingDraftAction経由)にも一致してしまい、nth(0)が
    // 意図せずそちらを押してしまう(実機E2Eで再現・特定 — task_48c715588f96367bc9)。
    // exact:trueでラベルが完全に「保存」の2ボタン(発送日数・配送料負担)
    // だけに絞る。
    await sectionSelect(page, "発送までの日数").selectOption("3");
    await page.getByRole("button", { name: "保存", exact: true }).nth(0).click();
    // ラベル文字列は<select>の<option>にも常在するため、サマリspanだけを見る。
    await expect(sectionSummary(page, "発送までの日数")).toHaveText("4〜7日で発送", { timeout: 10_000 });

    // 配送料の負担
    // task_1d6008f0c4f2ef3468是正: 発送元/配送方法/CSV公開設定にもそれぞれ
    // 独立した「保存」(exact)ボタンが増えたため、「exact一致の保存ボタンは
    // 発送日数・配送料負担の2つだけ」という前提(上のコメント)はもう成立
    // しない——ページ全体からの最後のボタン取得は別項目を誤って押しうる。
    // sectionSaveButton(見出し紐づけ)で確実に絞り込む。
    await sectionSelect(page, "配送料の負担").selectOption("1");
    await sectionSaveButton(page, "配送料の負担").click();
    await expect(sectionSummary(page, "配送料の負担")).toHaveText("送料込（出品者負担）", { timeout: 10_000 });

    // 再読込しても保存済みの値が保持される(=実際にサーバー側へ永続化されている、クライアント側の楽観的更新だけではない)。
    await page.reload();
    await expect(page.locator(`text=${FURNITURE_CATEGORY_ID}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("text=Xmiss").first()).toBeVisible();
    await expect(sectionSummary(page, "配送料の負担")).toHaveText("送料込（出品者負担）");
    // task_1d6008f0c4f2ef3468是正: 常設ヘルプ文にも"未確定"という語が
    // 含まれるようになった(下の同名コメント参照)ため、ページ全体からの
    // 正規表現一致ではなくカテゴリー未確定バナー自体の文言だけへ絞り込む。
    await expect(page.getByText("未確定（最終CSV出力がブロックされます。他の項目は先に保存できます）")).toHaveCount(0);
  });

  /**
   * task_1d6008f0c4f2ef3468(2026-09-15是正)の本題: 発送元/配送方法/CSV
   * 公開設定はカテゴリー未確定でも独立して保存でき、既定値(発送元jp11/
   * 配送方法1=出品者手配/CSV公開設定2=公開)と実績例外(配送方法3=
   * らくらくメルカリ便)の両方をUIで選べる。
   * scripts/verify-mercari-csv-edit-save.tsのtask_1d6008f0c4f2ef3468
   * セクションが同じシナリオをNodeからservice.tsを直接叩いて検証済み
   * ——ここでは実ブラウザ・実Server Action経路で同じ順序(発送元→
   * 配送方法→CSV公開設定→カテゴリー後付け)を通す。専用id
   * (E2E_MERCARI_CSV_SHIPPING_EXTRAS_ID="e2e-inv-53"、lib/listing/
   * e2eFixtures.ts参照)を使い、48番(既存のカテゴリー/発送日数/配送料
   * 負担の検証)と保存済み状態が混ざらないようにする。
   */
  test("発送元/配送方法(既定1・実績例外3)/CSV公開設定をカテゴリー未確定のまま独立保存→再読込で保持→カテゴリー後付けしても失われない", async ({ page }) => {
    test.setTimeout(45_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-53/listing");
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("未確定（最終CSV出力がブロックされます。他の項目は先に保存できます）")).toBeVisible();

    // 保存前は既定値(発送元jp11/配送方法=出品者手配/CSV公開設定=公開)が表示されている。
    await expect(page.getByText("未設定（既定値「jp11」を適用してCSV出力）")).toBeVisible();
    await expect(page.getByText("未設定（既定値「出品者手配」を適用してCSV出力）")).toBeVisible();
    await expect(page.getByText("未設定（既定値「CSV出力時: 公開」を適用してCSV出力）")).toBeVisible();

    // 発送元の地域(自由入力)をカテゴリー未確定のまま独立保存。
    await sectionInput(page, "発送元の地域").fill("jp13");
    await sectionSaveButton(page, "発送元の地域").click();
    await expect(sectionSummary(page, "発送元の地域")).toHaveText("jp13", { timeout: 10_000 });

    // 配送方法=実績例外3(らくらくメルカリ便)を独立保存。
    await sectionSelect(page, "配送方法").selectOption("3");
    await sectionSaveButton(page, "配送方法").click();
    await expect(sectionSummary(page, "配送方法")).toHaveText("らくらくメルカリ便", { timeout: 10_000 });

    // CSV出力時の公開設定=非公開(既定の公開から変更)を独立保存。
    await sectionSelect(page, "CSV出力時の公開設定").selectOption("1");
    await sectionSaveButton(page, "CSV出力時の公開設定").click();
    await expect(sectionSummary(page, "CSV出力時の公開設定")).toHaveText("CSV出力時: 非公開", { timeout: 10_000 });

    // カテゴリーはまだ未確定——最終CSV出力はまだブロックされる。
    await expect(page.getByText("未確定（最終CSV出力がブロックされます。他の項目は先に保存できます）")).toBeVisible();

    // 再読込しても3項目とも保持される(サーバー側へ実際に永続化されている確認)。
    await page.reload();
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    await expect(sectionSummary(page, "発送元の地域")).toHaveText("jp13", { timeout: 15_000 });
    await expect(sectionSummary(page, "配送方法")).toHaveText("らくらくメルカリ便");
    await expect(sectionSummary(page, "CSV出力時の公開設定")).toHaveText("CSV出力時: 非公開");

    // カテゴリーを後付けしても、先に保存した3項目が消えない(persist()のPartial patch/merge)。
    await selectFurnitureCategoryById(page);
    await expect(page.getByText("保存しました。")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`text=${FURNITURE_CATEGORY_ID}`)).toBeVisible();
    await expect(sectionSummary(page, "発送元の地域")).toHaveText("jp13");
    await expect(sectionSummary(page, "配送方法")).toHaveText("らくらくメルカリ便");
    await expect(sectionSummary(page, "CSV出力時の公開設定")).toHaveText("CSV出力時: 非公開");
    // task_1d6008f0c4f2ef3468是正: 「カテゴリーが未確定のままでも先に選んで
    // 保存できます」等の常設ヘルプ文にも"未確定"という語が含まれるように
    // なった(冒頭説明文・発送日数/送料負担セクションの説明文)ため、
    // ページ全体からの正規表現一致では常に3件ヒットして誤検知する。
    // カテゴリー未確定バナー自体の文言だけへ絞り込む。
    await expect(page.getByText("未確定（最終CSV出力がブロックされます。他の項目は先に保存できます）")).toHaveCount(0);

    // 再読込しても(カテゴリー確定後も)全項目が保持される。
    await page.reload();
    await expect(page.locator(`text=${FURNITURE_CATEGORY_ID}`)).toBeVisible({ timeout: 15_000 });
    await expect(sectionSummary(page, "発送元の地域")).toHaveText("jp13");
    await expect(sectionSummary(page, "配送方法")).toHaveText("らくらくメルカリ便");
    await expect(sectionSummary(page, "CSV出力時の公開設定")).toHaveText("CSV出力時: 非公開");
  });

  test("VIEWER権限では出品編集ページ自体を開けない(保存導線に到達できない)", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page, "VIEWER");
    await page.goto("/inventory/e2e-inv-41/listing");
    // app/inventory/(protected)/[id]/listing/page.tsxのcanEditInventory(role)
    // チェックがVIEWERをnotFound()で弾く——これはこのタスクの変更対象外の
    // 既存境界(在庫編集権限=出品編集権限)で、実機E2Eで実際にこの経路を
    // 通ることを確認した(元のテストは「ページは開けて保存ボタンで権限
    // エラーが出る」ことを期待していたが、実際にはページ自体に到達
    // できず、その前提が誤りだった)。「保存できない」の中でも最も強い
    // 形——保存UIにそもそも到達できない——を検証する。
    await expect(page.getByText("お探しのページは見つかりませんでした")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toHaveCount(0);
  });

  test("保存失敗時は選択中の値が画面から消えない(入力保持)", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-49/listing");
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });

    const daysSelect = sectionSelect(page, "発送までの日数");
    await daysSelect.selectOption("4");
    await page.getByRole("button", { name: "保存", exact: true }).nth(0).click();
    // MercariCategoryMappingSection.tsxのpersist()はcatchしたErrorの
    // message(サーバー側の実際の失敗理由)をそのまま表示する(汎用文言
    // 「保存に失敗しました。」へ丸めない)——lib/listing/e2eFixtures.tsの
    // 合成失敗fixtureが投げる実際の文言に合わせる(実機E2Eで確認)。
    await expect(page.getByText(/\[e2e-fixture\] simulated saveChannelOverride failure/)).toBeVisible({ timeout: 10_000 });
    // 保存は失敗したが、セレクトの表示値はユーザーが選んだ"90日以内に発送"(4)のまま——保存前の確定値へ黙って戻さない。
    await expect(daysSelect).toHaveValue("4");
  });

  /**
   * task_e8b97d6b40aad90fff(2026-09-15)是正の本題:
   * 「編集後CSVdownloadを省略しており未検証」を埋める——scripts/verify-
   * mercari-csv-edit-save.tsはservice.tsの関数をNodeから直接呼ぶだけで
   * 実UIの「一覧のCSV生成ボタン」自体は一度も押していない(このspecの
   * 冒頭コメントの既知の制約)。APIがブラウザから呼べないという推測で
   * 省略せず、実際に押して実downloadし、独立parser(independentParse.ts
   * ——serialize.tsとは別ロジック)で編集値との一致を確認する。
   *
   * task_ca862bd2a1f6fbf60d(2026-09-15)是正: e8報告時点では配送料の負担
   * =送料別(2)を選ぶとCSV側は送料ID必須(validate.ts)なのに送料IDを
   * 入力するUI自体が無く、このテストは検証を諦めて送料込(1)で経路だけ
   * を確認していた(残課題としてコメントに明記されていた)。
   * MercariCategoryMappingSection.tsxに送料ID入力欄を追加したので、
   * ここでは本来検証すべきだった送料別+送料IDの経路を実際に通す。
   *
   * 対象idはlib/listing/e2eFixtures.tsのE2E_LISTINGS_OVERVIEW_BULK_ROW_ID
   * ("e2e-listing-40")——一覧(/inventory/listings)のCSVモードから選択
   * できる行の中で唯一「未確定から編集する」ために使える(商品数上限
   * 超過検証専用の21件目を流用。そちらの検証は選択件数だけを見て
   * 個別商品を解決する前に拒否するため、この行へ実データを持たせても
   * 既存挙動に影響しない——同ファイルのコメント参照)。
   */
  test("単品ページで編集(送料別+送料ID)→保存→一覧のCSV生成ボタンを実際に押して実downloadしたCSVが独立parseで編集値と一致する", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const TARGET_ID = "e2e-listing-40";
    const FEE_ID = "fee-e2e-40001";
    const BRAND_ID = "225nDaWCk4MpMbnFP6a5An";

    await page.goto(`/inventory/${TARGET_ID}/listing`);
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("未確定（最終CSV出力がブロックされます。他の項目は先に保存できます）")).toBeVisible();

    // Save brand and shipping settings before choosing a category, then verify
    // the actual downloaded CSV after reload and category assignment.
    await page.getByPlaceholder("ブランド名（和名/カナ/英語）で検索").fill("キスミス");
    await page.getByRole("button", { name: new RegExp(BRAND_ID) }).click();
    await expect(page.getByText("保存しました。")).toBeVisible();
    await sectionInput(page, "発送元の地域").fill("jp13");
    await sectionSaveButton(page, "発送元の地域").click();
    await expect(sectionSummary(page, "発送元の地域")).toHaveText("jp13");
    await sectionSelect(page, "CSV出力時の公開設定").selectOption("1");
    await sectionSaveButton(page, "CSV出力時の公開設定").click();
    await expect(sectionSummary(page, "CSV出力時の公開設定")).toHaveText("CSV出力時: 非公開");
    await page.reload();
    await expect(page.getByText("未確定（最終CSV出力がブロックされます。他の項目は先に保存できます）")).toBeVisible();
    await expect(page.getByText(BRAND_ID, { exact: false })).toBeVisible();
    await selectFurnitureCategoryById(page);
    await expect(page.getByText("保存しました。")).toBeVisible({ timeout: 10_000 });

    await sectionSelect(page, "発送までの日数").selectOption("2");
    await sectionSaveButton(page, "発送までの日数").click();
    await expect(sectionSummary(page, "発送までの日数")).toHaveText("2〜3日で発送", { timeout: 10_000 });

    // 配送料の負担=送料別(2)を選ぶと、送料ID欄が動的に現れる
    // (MercariCategoryMappingSection.tsxの表示条件、実装方針§4
    // 「送料別を選択時のみ送料ID欄を表示」)。
    await sectionSelect(page, "配送料の負担").selectOption("2");
    await expect(sectionInput(page, "送料ID")).toBeVisible({ timeout: 10_000 });
    await sectionSaveButton(page, "配送料の負担").click();
    await expect(sectionSummary(page, "配送料の負担")).toHaveText("送料別（購入者負担）", { timeout: 10_000 });

    // task_ca862bd2a1f6fbf60d是正の本題その1: 送料別を選んだが送料IDが
    // まだ空欄の状態で一覧のCSV生成を実行すると、実行自体はブロックせず
    // (buildExportRowForInventoryはブロックしない、assembleRow.ts参照)、
    // CSV生成の最終段(validateMercariCsvRow)で理由付きに拒否される
    // ——「途中空欄保存許可、CSV生成時は必須検証」(実装方針§4)。
    await gotoListingsOverview(page);
    await page.getByRole("button", { name: "CSVを作成" }).click();
    await page.getByPlaceholder("商品名・在庫IDで絞り込み").fill("E2E-0040");
    const rowBeforeFeeId = page.locator("tbody tr", { hasText: "E2E-0040" });
    await expect(rowBeforeFeeId).toHaveCount(1);
    await rowBeforeFeeId.getByRole("checkbox").check();
    await page.getByTitle(/商品一括登録CSV/).click();
    // 送料ID未入力の商品を含むためCSV生成がブロックされ、理由に「送料ID」が含まれる(黙って除外・成功にしない)。
    await expect(page.getByText(/送料ID/).first()).toBeVisible({ timeout: 10_000 });

    // task_ca862bd2a1f6fbf60d是正の本題その2: 単品ページへ戻り送料IDを
    // 入力・保存する(配送料の負担とは別の保存ボタン——途中空欄保存を
    // 許容する設計のため、それぞれ独立して保存できる)。
    await page.goto(`/inventory/${TARGET_ID}/listing`);
    await expect(sectionSummary(page, "配送料の負担")).toHaveText("送料別（購入者負担）", { timeout: 15_000 });
    await sectionInput(page, "送料ID").fill(FEE_ID);
    await sectionSaveButton(page, "送料ID").click();
    await expect(sectionSummary(page, "送料ID")).toHaveText(FEE_ID, { timeout: 10_000 });

    // 再読込しても送料別+送料IDが保持される(save→reloadの確認)。
    await page.reload();
    await expect(page.locator(`text=${FURNITURE_CATEGORY_ID}`)).toBeVisible({ timeout: 15_000 });
    await expect(sectionSummary(page, "配送料の負担")).toHaveText("送料別（購入者負担）");
    await expect(sectionSummary(page, "送料ID")).toHaveText(FEE_ID);

    // ここから本題その3: 一覧のCSV生成ボタンを実際に押して実downloadする。
    await gotoListingsOverview(page);
    await page.getByRole("button", { name: "CSVを作成" }).click();
    // 一覧側のdisplayId("E2E-0040"、lib/listing/e2eFixtures.tsのbuildRows()
    // が付ける名前)で絞り込む——CSVの中身が使うInventory側displayId
    // ("LST-0040"、lib/inventory/e2eFixtures.ts)とは別の名前空間
    // (両ファイルの冒頭コメント参照)。
    await page.getByPlaceholder("商品名・在庫IDで絞り込み").fill("E2E-0040");
    const row = page.locator("tbody tr", { hasText: "E2E-0040" });
    await expect(row).toHaveCount(1);
    await row.getByRole("checkbox").check();

    const csvExportButton = page.getByTitle(/商品一括登録CSV/);
    const [csvDownload] = await Promise.all([page.waitForEvent("download"), csvExportButton.click()]);
    const csvBuf = await downloadToBuffer(csvDownload);

    // 独立parse: CP932デコード自体は往復試験済みの標準変換(検証対象では
    // ない)を再利用しつつ、行の切り出しはserialize.tsと別ロジックの
    // independentParse.tsで行う(同じコードで読み返したのでは検出でき
    // ないバグを防ぐ、independentParse.ts冒頭コメントの方針と同じ)。
    const csvText = decodeCp932(csvBuf);
    const rows = parseCsvIndependent(csvText);
    // mapRowToCells.ts: 24列目=商品管理番号(managementCode)、
    // 74列目=カテゴリーID、78列目=発送までの日数、80列目=配送料の負担、
    // 81列目=送料ID。
    const dataRow = rows.find((cells) => cells[24] === "LST-0040");
    expect(dataRow, `LST-0040の行がCSVに含まれる(実際の行数: ${rows.length})`).toBeTruthy();
    if (dataRow) {
      expect(dataRow).toHaveLength(88);
      expect(dataRow[72]).toBe(BRAND_ID);
      expect(dataRow[74]).toBe(FURNITURE_CATEGORY_ID);
      expect(dataRow[76]).toBe("1");
      expect(dataRow[77]).toBe("jp13");
      expect(dataRow[78]).toBe("2"); // 「2〜3日で発送」のコード値
      expect(dataRow[79]).toBe("1");
      expect(dataRow[80]).toBe("2"); // 「送料別（購入者負担）」のコード値
      expect(dataRow[81]).toBe(FEE_ID); // 送料ID
    }
  });
});
