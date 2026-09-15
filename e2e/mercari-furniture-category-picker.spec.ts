import { test, expect, type Page } from "@playwright/test";

/**
 * 家具店向け効率化指示書(2026-09-15)是正(task_302c7e3c24b575629d) §7-1/2/6
 * /4-D専用: 8入口ナビゲータ(MercariFurnitureCategoryPicker.tsx)自体の
 * 実ブラウザ検証。
 *
 * task_302c7e3c24b575629d(2026-09-15是正)の経緯(1回目): 前回実装
 * (task_b1b6caa7bac795f96b)のこのファイルは、初回木構造取得(1回)より
 * 「後」の通信を`page.on("request")`で無差別に数え、件数が増えないこと
 * だけを見ていた——Next.jsの開発サーバー通信(HMR等)や無関係な画像
 * リクエストが偶然その計測窓に紛れ込むと、枝クリック自体とは無関係な
 * 理由で誤って壊れうる不安定な検証だった。
 *
 * task_302c7e3c24b575629d是正(2回目、独自furniture-own-e2e.logの実測後):
 * `next-action`ヘッダ付きPOSTだけに絞っても、まだ「このページ上で動く
 * 他セクションが独自に発するServer Action」が混入することを実測で確認
 * した——/inventory/[id]/listingページにはMercariCategoryMappingSection
 * (このピッカーの親)以外にBaseListingSection(isBaseConnectedAction/
 * getBaseChannelListingAction)、ShippingReferencePriceSection
 * (getShippingReferencePriceAction)等が同居し、いずれも初回マウント時に
 * 独自のServer Actionを発する。これらは`next-action`ヘッダを持つ点で
 * ピッカーの通信と区別がつかず、単純なヘッダ有無フィルタでは「初回は
 * ちょうど1回」という絶対数の主張ができない(実測: フィルタ後でも8件)。
 *
 * task_302c7e3c24b575629d是正(3回目、公開前検証・実測後、task_a2a77378a1c45bdc3b):
 * 2回目の是正はレスポンス本文にマーカー文字列を含むかどうかを
 * `response.text()`で判定していたが、実測(furniture-final-own-e2e.log)で
 * `waitForStableTreeFetchBaseline`が5秒待ってもcount()===0のまま失敗した
 * (画面上は8入口が正しく描画済みで、通信自体は実際に成功している)。
 * 原因はマーカー判定そのものではなく、`page.on("response", ...)`内で
 * `res.text()`を`.then()`チェーンの非同期完了を待たずに登録するだけの
 * fire-and-forget実装だった——Next.js dev serverのServer Action応答は
 * chunked転送のRSC Flightストリームで、`res.text()`の解決に数百ms〜
 * かかることがあり、`expect.poll`が最初にtracker.count()を評価する
 * 5秒枠のごく初期(まだ`res.text()`が解決していない僅かな窓)に限れば
 * 理論上は0のままになりうる。より本質的な問題は、イベントハンドラ内で
 * 例外(ナビゲーション中断等)が発生した場合にcatchで握りつぶすだけで
 * 「対象レスポンスを捕捉できなかった」というシグナルが一切残らず、
 * デバッグ時に「本当に0件なのか、判定ロジックが取りこぼしただけなのか」
 * を区別できなかったこと。対応として、(a)`response`ではなく`requestfinished`
 * を起点にして、レスポンス本文の取得を`Promise`として保持し
 * `waitForStableTreeFetchBaseline`側で全て解決してからcountを評価する
 * (非同期の取りこぼし窓を作らない)、(b)捕捉に失敗した候補
 * (POST+next-actionヘッダを持つが本文が読めなかった等)を別途記録し、
 * baseline待ちがタイムアウトした場合はその診断情報をエラーメッセージに
 * 含める(次に同じ問題が起きた時に「マーカー不一致」と「取りこぼし」を
 * 区別できるようにする)——このファイル下部のtrackTargetActionResponses/
 * waitForStableTreeFetchBaselineの実装コメント参照。
 *
 * 対応: リクエストの宛先URL/メソッド/ヘッダだけでなく、実際に返って
 * きた「レスポンス本文の内容」を対象Actionの根拠として使う——
 * getMercariFurnitureCategoryTreeAction()の戻り値(FurnitureCategoryBucket[])
 * には他のどのActionの戻り値にも出現しない固有のJSONキー値
 * (TREE_FETCH_MARKER、furnitureCategoryTree.tsのNAMED_FURNITURE_BUCKETSに
 * ある7つの固定bucket keyの1つ)が必ず含まれ、
 * saveChannelOverrideAction()の戻り値(更新後のChannelListingRecord)には
 * 今回確定した実在カテゴリIDを`mercariCategoryId`キーで持つ組み合わせ
 * (SAVE_ACTION_MARKER)が必ず含まれる——単なるカテゴリID文字列だけを
 * マーカーにすると、木構造応答にも同じID(シーリングライトが木の中の
 * 1リーフとして`categoryId`キーで登場する)が混入するため、キー名まで
 * 含めて区別する(実測で判明、このファイル下部のSAVE_ACTION_MARKERの
 * コメント参照)。他セクションのActionの戻り値(価格情報・BASE連携状態等)
 * にこれらの文字列が偶然含まれることはない。これにより「対象Action/
 * リクエストの根拠」を明示しつつ、他セクションの通信・無関係な画像/
 * Next開発通信(next-actionヘッダ無し)を同じ件数に混入させない。
 *
 * マーカーはASCII文字列限定にしている——実測で判明した副次的な問題として、
 * このPlaywright/Chromium実行環境ではCDP経由のresponse.body()が、
 * Content-Typeにcharset=utf-8が明示されないRSCアクションレスポンスの
 * 日本語部分を誤ったcharset(latin1相当)で一度decode/re-encodeした状態で
 * 返す(実機のブラウザ描画自体は正しいUTF-8で行われており、画面表示
 * そのものには影響しない——あくまでテストコード側でresponse.body()を
 * 生で読んだ時にだけ文字化けする)。日本語ラベルをマーカーに使うと
 * この文字化けで一致判定が常にfalseになり誤って壊れるため、ASCIIのみの
 * 固有文字列(bucket keyのkey名、カテゴリID)をマーカーに採用する。
 *
 * 初回木構造取得の絶対回数を「常に1」と断定しない理由(実測で判明): この
 * webServerは`next dev`(playwright.config.ts、E2Eフィクスチャの二重ゲートの
 * 都合上devモード必須)を使う——React 18のStrict Modeは開発サーバーでのみ
 * マウント時のeffectを意図的に二重発火させる(本番ビルド`next build`+
 * `next start`では発生しない、Reactが未クリーンアップの副作用を検出する
 * ための既知の仕様)。そのため初回の木構造取得回数は実行環境により1回にも
 * 2回にもなりうる。指示書§4-G「枝のクリック毎の全件マスタ再読込を避ける」
 * が本当に検証したいのは絶対回数ではなく「マウント後に安定した回数から、
 * 枝クリックで増えない」ことなので、初回に実際に観測された回数を
 * baselineとして採用し、以降はその差分(増分ゼロ)だけを見る。
 *
 * webServer(playwright.config.ts)がINVENTORY_E2E_FIXTURES=1を渡すため、
 * 実AWSには一切到達しない。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
const E2E_PORT = process.env.E2E_PORT ?? "3100";
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
const TARGET_ID = "e2e-inv-51";
// 家具内検索テスト専用(lib/listing/e2eFixtures.tsのE2E_MERCARI_FURNITURE_SEARCH_ID)
// ——TARGET_IDはドリルダウン保存テストが実際に保存するため共有しない。
const SEARCH_TARGET_ID = "e2e-inv-52";
// e2e/mercari-csv-edit-save.spec.tsのFURNITURE_CATEGORY_ID/FULL_PATHと
// 同じ実在の家具カテゴリ(getCategoryById検証済み、
// scripts/verify-mercari-csv-export.tsのtestFurnitureCategoryTree参照)。
const CEILING_LIGHT_CATEGORY_ID = "u9jzuziaZ4F9BeP8Dk3RwD";
// saveChannelOverrideAction()の戻り値(ChannelListingRecord)だけに出現する
// キー:値の組み合わせ。木構造取得の応答にもこのcategoryId自体は含まれる
// (シーリングライトが木の中の1リーフのため)が、フィールド名は
// `categoryId`(furnitureCategoryTree.ts)であり`mercariCategoryId`
// (lib/listing/types.ts、ChannelListingRecord.categoryMapping)ではない
// ——キー名まで含めて一致させることで木構造応答との衝突を避ける。
const SAVE_ACTION_MARKER = `"mercariCategoryId":"${CEILING_LIGHT_CATEGORY_ID}"`;
const CEILING_LIGHT_FULL_PATH = "家具・インテリア > ライト・照明 > シーリングライト・天井照明 > シーリングライト";
// 既存の非家具カテゴリ(K-POP)が既に保存済みの合成id(lib/listing/
// e2eFixtures.tsのe2eMercariCsvChannelListing、E2E_MERCARI_ZIP_SINGLE_ID)。
// 「旧範囲外カテゴリは現在値を表示保持」の検証専用——このidの下書き/
// カテゴリー自体は変更しない(公開CSV/ZIP系の既存検証対象と共有)。
const NON_FURNITURE_EXISTING_ID = "e2e-inv-41";
const NON_FURNITURE_EXISTING_CATEGORY_ID = "iBDxa3BbcUz8XWrr5pgq2Z";

// 家具店向け効率化指示書§4-Aの8入口(7分類+その他)。並び順はfurnitureCategoryTree.tsの
// NAMED_FURNITURE_BUCKETS定義順+「その他」が末尾。
const EXPECTED_ENTRY_LABELS = ["ライト・照明", "机・テーブル", "椅子・チェア", "ソファ・ソファベッド", "棚・ラック・シェルフ", "ベッド", "事務・店舗用品", "その他"];

// getMercariFurnitureCategoryTreeAction()の戻り値だけに出現する固有の
// JSONキー値(furnitureCategoryTree.tsのNAMED_FURNITURE_BUCKETSの
// bucket key、ASCII、上のファイル冒頭コメント参照)。他のどのServer
// Action(価格参照/BASE連携状態等)の戻り値にも出現しない。
const TREE_FETCH_MARKER = '"key":"shelf"';

async function signIn(page: Page, role: "ADMIN" | "EDITOR" | "VIEWER" = "ADMIN") {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `${role}:${E2E_TOKEN}`, url: E2E_BASE_URL }]);
}

/** MercariFurnitureCategoryPicker.tsx自身のルート要素だけを指す(data-testid、他の検索欄とのlocator衝突を避ける明示的なコンテナ)。 */
function picker(page: Page) {
  return page.getByTestId("mercari-furniture-category-picker");
}

/** 8入口ボタン一覧(ドリルダウン前のみ表示)。ピッカー自身のコンテナ内に限定する。 */
function entryButtons(page: Page) {
  return picker(page).getByRole("button", { name: new RegExp(`^(${EXPECTED_ENTRY_LABELS.join("|")})$`) });
}

/** Capture real local Server Action responses before Chromium discards streamed bodies. */
const observedActions = new WeakMap<Page, { responses: { url: string; body: string }[]; unreadable: number }>();
async function trackTargetActionResponses(page: Page, marker: string) {
  let observed = observedActions.get(page);
  if (!observed) {
    observed = { responses: [], unreadable: 0 };
    observedActions.set(page, observed);
    const state = observed;
    // Chromium can discard streamed RSC bodies before response.text() reads
    // them. Capture the real response before delivering the unchanged bytes.
    // No action result is mocked; every action still reaches the local server.
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.method() !== "POST" || !(await req.headerValue("next-action"))) {
        await route.continue();
        return;
      }
      try {
        const response = await route.fetch();
        const body = await response.body();
        state.responses.push({ url: req.url(), body: body.toString("utf8") });
        await route.fulfill({ response, body });
      } catch (error) {
        state.unreadable++;
        throw error;
      }
    });
  }
  const state = observed;
  async function resolveMatches(): Promise<{ url: string; body: string }[]> {
    return state.responses.filter((r) => r.body.includes(marker));
  }
  return {
    count: async () => (await resolveMatches()).length,
    urls: async () => (await resolveMatches()).map((r) => r.url),
    unreadableCount: () => state.unreadable,
  };
}

/**
 * 初回マウント直後、木構造取得(getMercariFurnitureCategoryTreeAction)の
 * 回数が安定するまで待ち、その時点の回数をbaselineとして返す——React
 * Strict Modeの開発時二重effect発火(このファイル冒頭コメント参照)を
 * 考慮し、1回以上であることだけを確認する(絶対値は1にも2にもなりうる)。
 *
 * タイムアウトした場合は`tracker.unreadableCount()`(本文取得に失敗した
 * 候補の件数)をエラーメッセージに含める——「対象Actionが本当に発生
 * していない」のか「発生したが本文が読めず判定ロジックが取りこぼした」
 * のかを次回の調査で即座に区別できるようにする(task_a2a77378a1c45bdc3b
 * 是正、このファイル冒頭コメント参照)。
 */
async function waitForStableTreeFetchBaseline(tracker: { count: () => Promise<number>; unreadableCount: () => number }): Promise<number> {
  try {
    await expect.poll(() => tracker.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
  } catch (err) {
    // タイムアウトした場合は本文取得に失敗した候補の件数を付記する——
    // 「対象Actionが本当に発生していない」のか「発生したが本文が読めず
    // 判定ロジックが取りこぼした」のかを次回の調査で即座に区別できる
    // ようにする(task_a2a77378a1c45bdc3b是正、このファイル冒頭コメント参照)。
    const detail = `getMercariFurnitureCategoryTreeActionの応答が検出できません(本文取得に失敗した候補: ${tracker.unreadableCount()}件)`;
    if (err instanceof Error) err.message = `${detail}\n${err.message}`;
    throw err;
  }
  // Strict Modeの2回目のeffect発火(あれば)が届くまでの猶予。
  await new Promise((resolve) => setTimeout(resolve, 300));
  return tracker.count();
}

test.describe("Mercari 8入口カテゴリナビゲータ(MercariFurnitureCategoryPicker)の実UI検証", () => {
  test.afterEach(async ({ page }) => {
    // A reload can start another real action at the end of the assertions.
    // Drain it before Playwright disposes this test's request context.
    await page.unrouteAll({ behavior: "wait" });
  });
  test("8入口が表示され家具外カテゴリが出ない、ドリルダウン→パンくず→決定ボタンの活性/非活性→保存→再読込で復元される", async ({ page }) => {
    test.setTimeout(45_000);
    await signIn(page);

    // 初回マウント時の木構造取得(getMercariFurnitureCategoryTreeAction)
    // 1回分を含めて計測を開始する(goto前からリスナーを張る)。
    const treeFetch = await trackTargetActionResponses(page, TREE_FETCH_MARKER);
    const save = await trackTargetActionResponses(page, SAVE_ACTION_MARKER);
    await page.goto(`/inventory/${TARGET_ID}/listing`);
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    // task_1d6008f0c4f2ef3468是正(MercariCategoryMappingSection.tsx):
    // カテゴリー未確定でも他項目を先に保存できるようになった案内を含めて
    // 文言が変わった("最終CSV出力がブロックされます。他の項目は先に
    // 保存できます")。
    await expect(page.getByText("未確定（最終CSV出力がブロックされます。他の項目は先に保存できます）")).toBeVisible();

    // 1) 8入口が表示され、家具外の分類(例: ファッション/家電等)は一切出ない。
    const buttons = entryButtons(page);
    await expect(buttons).toHaveCount(EXPECTED_ENTRY_LABELS.length, { timeout: 15_000 });
    const labels = await buttons.allTextContents();
    expect(labels).toEqual(EXPECTED_ENTRY_LABELS);

    // 初回表示までに実際に発生した木構造取得(getMercariFurnitureCategoryTreeAction)
    // の回数をbaselineとして固定する(Strict Modeの開発時二重発火により
    // 1または2、このファイル冒頭コメント参照)。同じページに同居する他
    // セクション独自のServer Action(BaseListingSection/
    // ShippingReferencePriceSection等)はマーカーで除外済みのため、この数に
    // 混入しない。保存(saveChannelOverrideAction)はまだ1度も実行していない
    // ため0件。
    const treeFetchBaseline = await waitForStableTreeFetchBaseline(treeFetch);
    expect(await save.count(), "決定ボタンを押すまでsaveChannelOverrideActionは発生しない").toBe(0);

    // 2) 「ライト・照明」入口を開く。入口自体は正式IDを持たないため
    // 「このカテゴリに決定」ボタンは存在せず、案内文が出る(決定ボタンの非活性)。
    await picker(page).getByRole("button", { name: "ライト・照明", exact: true }).click();
    await expect(picker(page).getByText("この階層はまだ公式カテゴリではありません。")).toBeVisible();
    await expect(picker(page).getByRole("button", { name: "このカテゴリに決定" })).toHaveCount(0);
    // パンくず: 「カテゴリー一覧」リンク + 現在地(太字、リンクではない)。
    await expect(picker(page).getByRole("button", { name: "カテゴリー一覧" })).toBeVisible();
    await expect(picker(page).locator("span.font-bold", { hasText: "ライト・照明" })).toBeVisible();

    // 3) 子階層「シーリングライト・天井照明」へ進む(中間階層、まだ正式IDなし)。
    await picker(page).getByRole("button", { name: /^シーリングライト・天井照明/ }).click();
    await expect(picker(page).getByText("この階層はまだ公式カテゴリではありません。")).toBeVisible();
    await expect(picker(page).getByRole("button", { name: "このカテゴリに決定" })).toHaveCount(0);
    // パンくず: ライト・照明(リンク) > シーリングライト・天井照明(現在地、太字)。
    await expect(picker(page).getByRole("button", { name: "ライト・照明", exact: true })).toBeVisible();
    await expect(picker(page).locator("span.font-bold", { hasText: "シーリングライト・天井照明" })).toBeVisible();

    // 4) 末端「シーリングライト」(公式カテゴリID実在、verify済み: u9jzuziaZ4F9BeP8Dk3RwD)へ進む。
    await picker(page).getByRole("button", { name: "シーリングライト", exact: true }).click();
    const decideButton = picker(page).getByRole("button", { name: "このカテゴリに決定" });
    await expect(decideButton).toBeVisible();
    await expect(decideButton).toBeEnabled();

    // この時点まで(入口表示→2回のドリルダウン)、木構造取得はbaselineの
    // まま増えていない(枝クリック毎の再取得なし)。保存もまだ0件のまま。
    expect(await treeFetch.count(), "枝のクリックを何度行っても木構造の再取得は発生しない").toBe(treeFetchBaseline);
    expect(await save.count()).toBe(0);

    // 5) 「戻る」で1階層戻り、パンくずクリックで再度末端へ進めることを確認する。
    await picker(page).getByRole("button", { name: "戻る" }).click();
    await expect(picker(page).locator("span.font-bold", { hasText: "シーリングライト・天井照明" })).toBeVisible();
    await picker(page).getByRole("button", { name: "シーリングライト", exact: true }).click();
    await expect(decideButton).toBeEnabled();
    expect(await treeFetch.count(), "戻る操作・パンくず移動も枝展開と同じく木構造の再取得を発生させない").toBe(treeFetchBaseline);
    expect(await save.count()).toBe(0);

    // 6) 決定→保存。実Server Action(saveChannelOverrideAction)を通す。
    await decideButton.click();
    await expect(page.getByText("保存しました。")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(CEILING_LIGHT_CATEGORY_ID)).toBeVisible();
    await expect(page.getByText(CEILING_LIGHT_FULL_PATH)).toBeVisible();
    await expect.poll(() => save.count(), { timeout: 5_000 }).toBe(1);
    // 保存(saveChannelOverrideAction)は木構造を再取得しない別Actionのため、
    // 木構造取得は依然としてbaselineのまま。
    expect(await treeFetch.count(), "保存は木構造の再取得を伴わない").toBe(treeFetchBaseline);

    // 7) 再読込しても、正式フルパス・選択位置(パンくず)が復元される
    // (指示書§4-C「初期表示で正式フルパスと選択位置を復元」)。
    await page.reload();
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(CEILING_LIGHT_CATEGORY_ID)).toBeVisible();
    // 入口一覧(8ボタン)ではなく、保存済み経路のパンくずへ直接復元されている。
    await expect(picker(page).locator("span.font-bold", { hasText: "シーリングライト" }).last()).toBeVisible({ timeout: 15_000 });
    await expect(picker(page).getByRole("button", { name: "ライト・照明", exact: true })).toBeVisible();
    await expect(picker(page).getByRole("button", { name: "カテゴリー一覧" })).toBeVisible();
    // 復元後も末端ノードなので決定ボタンは活性のまま(再確定も可能)。
    await expect(picker(page).getByRole("button", { name: "このカテゴリに決定" })).toBeEnabled();
  });

  test("家具内検索(task_302c7e3c24b575629d §4-D是正)で家具カテゴリへ直接絞り込める。検索は家具限定で追加通信ゼロ", async ({ page }) => {
    test.setTimeout(45_000);
    await signIn(page);

    const treeFetch = await trackTargetActionResponses(page, TREE_FETCH_MARKER);
    const save = await trackTargetActionResponses(page, SAVE_ACTION_MARKER);
    await page.goto(`/inventory/${SEARCH_TARGET_ID}/listing`);
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    await expect(entryButtons(page)).toHaveCount(EXPECTED_ENTRY_LABELS.length, { timeout: 15_000 });
    const treeFetchBaseline = await waitForStableTreeFetchBaseline(treeFetch);

    const searchInput = picker(page).getByPlaceholder("家具カテゴリ名で検索（家具・インテリア配下のみ）");
    await searchInput.fill("シーリングライト");
    const resultButton = picker(page).getByRole("button", { name: CEILING_LIGHT_FULL_PATH, exact: true });
    await expect(resultButton).toBeVisible();
    // 検索結果に家具外のカテゴリ(K-POP等)が一切混ざらないことも確認する。
    await expect(picker(page).getByText(/K-POP/)).toHaveCount(0);

    await resultButton.click();
    // 検索結果クリックは即確定ではなく、経路への移動だけ(決定ボタンを
    // 押して初めて保存される、指示書§4-Bの「選択」と「確定」の分離を
    // 検索経路でも崩さない)。
    const decideButton = picker(page).getByRole("button", { name: "このカテゴリに決定" });
    await expect(decideButton).toBeEnabled();
    await expect(page.getByText("保存しました。")).toHaveCount(0);

    // 家具内検索・結果表示・経路移動はいずれも追加の通信を発生させない
    // (既に取得済みのbucketsをその場でフラット化するだけ)——木構造取得は
    // baselineのまま、保存もまだ0件。
    expect(await treeFetch.count(), "家具内検索は初回木構造取得以降、追加の通信を発生させない").toBe(treeFetchBaseline);
    expect(await save.count(), "検索結果のクリックだけでは保存されない").toBe(0);

    await decideButton.click();
    await expect(page.getByText("保存しました。")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(CEILING_LIGHT_CATEGORY_ID)).toBeVisible();
    await expect.poll(() => save.count(), { timeout: 5_000 }).toBe(1);
  });

  test("家具外の既存カテゴリは現在値のまま表示され続け、新規選択は家具限定に閉じている(旧来の全カテゴリ検索導線は存在しない)", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto(`/inventory/${NON_FURNITURE_EXISTING_ID}/listing`);
    await expect(page.getByText("Mercariカテゴリー / ブランド（CSV出力用）")).toBeVisible({ timeout: 15_000 });

    // 家具・インテリア以外の既存カテゴリ(K-POP)がそのまま表示され続ける
    // ——ピッカーが場所を特定できない(locateFurnitureCategoryPath=null)
    // からといって、既存値を消したり書き換えたりしない
    // (task_302c7e3c24b575629d §4「旧範囲外カテゴリは現在値を表示保持」)。
    await expect(page.getByText(NON_FURNITURE_EXISTING_CATEGORY_ID)).toBeVisible();

    // ピッカー自体は入口一覧(8ボタン)のまま——保存済みの経路が家具・
    // インテリア配下に無いため、パンくずへは復元されない(入口一覧
    // フォールバック)。
    await expect(entryButtons(page)).toHaveCount(EXPECTED_ENTRY_LABELS.length, { timeout: 15_000 });

    // 前回実装(task_b1b6caa7bac795f96b)にあった「他のカテゴリを検索/
    // 直接入力」という予備導線(全カテゴリ、家具外を含む新規選択が可能
    // だった)はこの是正で完全に削除されている——ページ上のどこにも
    // 存在しないことを確認する。
    await expect(page.getByRole("button", { name: /他のカテゴリ/ })).toHaveCount(0);
    await expect(page.getByPlaceholder("カテゴリー名で検索")).toHaveCount(0);

    // 新規選択は家具ピッカーからしかできない——「ライト・照明」から
    // 末端まで進むと決定ボタンが活性化し、家具カテゴリへ変更できる経路
    // 自体が存在することを確認する(実際の保存・置き換えはe2e-inv-51
    // 専用の別テストで検証済み——e2e-inv-41は他spec
    // (mercari-csv-image-download.spec.ts/mercari-csv-edit-save.spec.ts)
    // と共有する合成idのため、ここでは書き換えない=既存カテゴリの
    // 現在値保持をそのまま守る)。
    await picker(page).getByRole("button", { name: "ライト・照明", exact: true }).click();
    await picker(page).getByRole("button", { name: /^シーリングライト・天井照明/ }).click();
    await picker(page).getByRole("button", { name: "シーリングライト", exact: true }).click();
    await expect(picker(page).getByRole("button", { name: "このカテゴリに決定" })).toBeEnabled();

    // 決定はまだ押していないため、旧カテゴリ(K-POP)は変更されずそのまま。
    await expect(page.getByText(NON_FURNITURE_EXISTING_CATEGORY_ID)).toBeVisible();
  });
});
