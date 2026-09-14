/**
 * CSV候補e0fe20760b7a3c2b926f03b58b0c94108b6680fb 不足項目編集→保存→CSV
 * 再生成 未検証の是正(task_48c715588f96367bc9、2026-09-15)。
 *
 * lib/listing/service.tsのsaveChannelOverride/getChannelListingを、
 * Next.jsのRSCランタイムの外(素のNode/tsx)から直接呼び、
 *   1. カテゴリー/発送日数/配送料負担を「未確定」から実Actionの入力・
 *      検証コードを通して保存し、再取得すると保存した値がそのまま
 *      返ってくる(save→reload→CSV値一致の"save→reload"部分)。
 *   2. その状態でCSVを実際に生成すると、保存した値がCSV行にそのまま
 *      載る("→CSV値一致"の部分)。
 *   3. 新設したサーバー側入力検証(assertValidChannelOverrideInput)が
 *      不正なshippingDays/shippingPayer/overridePriceを拒否し、
 *      拒否時は状態を変えない(不正値拒否)。
 *   4. 保存が常に失敗する合成id(E2E_MERCARI_CSV_SAVE_FAIL_ID)では、
 *      例外が飛び、かつ保存済み状態が変わらない(実UI側のstate保持は
 *      e2e/mercari-csv-edit-save.spec.tsが実ブラウザで検証する——ここでは
 *      「サーバー側が本当に何も書き換えていない」ことをMapレベルで確認する)。
 *   5. 下書き価格が不正(300円未満)な商品はCSV生成がブロックされ、理由に
 *      価格が含まれる(価格不正拒否)。
 *   6. どの操作でもlib/amplify/dataClient.tsのe2eReadBoundaryLeaksが
 *      1件も増えない(SDK到達ゼロ)——scripts/verify-e2e-boundary-spy.ts
 *      と同じ検出機構を、この具体的な操作列に対して使う。
 *
 * 実行: node scripts/with-server-only-stub.cjs scripts/verify-mercari-csv-edit-save.ts
 */
export {};

process.env.INVENTORY_E2E_FIXTURES = "1";

let failures = 0;
let passes = 0;

function assertTrue(cond: boolean, label: string) {
  if (cond) {
    passes++;
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.error(`✗ FAIL: ${label}`);
  }
}

async function assertThrows(fn: () => Promise<unknown>, label: string) {
  try {
    await fn();
    failures++;
    console.error(`✗ FAIL: ${label} (例外が投げられなかった)`);
  } catch {
    passes++;
    console.log(`✓ ${label}`);
  }
}

async function main() {
  const { e2eReadBoundaryLeaks } = await import("../lib/amplify/dataClient");
  const { saveChannelOverride, getChannelListing } = await import("../lib/listing/service");
  const { buildExportRowForInventory } = await import("../lib/listing/mercari/csv/buildExportRows");
  const { buildMercariCsvExport } = await import("../lib/listing/mercari/csv/exportCsv");
  const { E2E_MERCARI_CSV_EDIT_ID, E2E_MERCARI_CSV_SAVE_FAIL_ID, E2E_MERCARI_CSV_INVALID_PRICE_ID } = await import("../lib/listing/e2eFixtures");

  const EDIT_ID = E2E_MERCARI_CSV_EDIT_ID;
  const KNOWN_CATEGORY_ID = "iBDxa3BbcUz8XWrr5pgq2Z";
  const KNOWN_CATEGORY_NAME = "CD・DVD・ブルーレイ > CD > K-POP・アジア";

  // ── 1. 未確定から始まる ──────────────────────────────────────────
  e2eReadBoundaryLeaks.length = 0;
  const before = await getChannelListing(EDIT_ID, "MERCARI_SHOPS");
  assertTrue(before === null, "編集対象商品はカテゴリー未確定(channelListing無し)から始まる");

  // ── 1.5 task_e8b97d6b40aad90fff(2026-09-15)是正の本題: カテゴリー未確定
  //        のまま発送日数だけ先に保存できる(段階的保存の退行防止) ──────
  const beforeCategoryDays = await saveChannelOverride(
    EDIT_ID,
    "MERCARI_SHOPS",
    { categoryMapping: { mercariCategoryId: "", mercariShippingDays: 2 }, overrideTitle: null, overrideDescription: null, overridePrice: null },
    "e2e-verify@example.com",
  );
  assertTrue(beforeCategoryDays.categoryMapping?.mercariShippingDays === 2, "カテゴリー未確定のまま発送日数の保存が成功する(拒否されない)");
  assertTrue(!beforeCategoryDays.categoryMapping?.mercariCategoryId, "その保存直後もcategoryIdは未確定(空)のまま");

  // 未完成CSVは理由付き拒否: カテゴリー未確定のままではCSV行の組み立て自体がブロックされる。
  const incompleteRow = await buildExportRowForInventory(EDIT_ID);
  assertTrue(incompleteRow.ok === false, "カテゴリー未確定のままではCSV行の組み立てがブロックされる(黙って空categoryIdを出力しない)");
  if (!incompleteRow.ok) {
    assertTrue(incompleteRow.reasons.some((r) => r.includes("カテゴリ")), `ブロック理由にカテゴリー関連の記述が含まれる(実際: ${JSON.stringify(incompleteRow.reasons)})`);
  }
  assertTrue(e2eReadBoundaryLeaks.length === 0, `段階的保存(発送日数のみ)までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // ── 2. カテゴリーを保存(検索→選択と同じ入力) ──────────────────────
  const afterCategory = await saveChannelOverride(
    EDIT_ID,
    "MERCARI_SHOPS",
    { categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariCategoryName: KNOWN_CATEGORY_NAME }, overrideTitle: null, overrideDescription: null, overridePrice: null },
    "e2e-verify@example.com",
  );
  assertTrue(afterCategory.categoryMapping?.mercariCategoryId === KNOWN_CATEGORY_ID, "カテゴリー保存直後の戻り値に選択したcategoryIdが載る");

  // ── 3. 発送日数を保存(既存のブランド/カテゴリーは保持) ────────────
  const afterShippingDays = await saveChannelOverride(
    EDIT_ID,
    "MERCARI_SHOPS",
    {
      categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariCategoryName: KNOWN_CATEGORY_NAME, mercariShippingDays: 3 },
      overrideTitle: null,
      overrideDescription: null,
      overridePrice: null,
    },
    "e2e-verify@example.com",
  );
  assertTrue(afterShippingDays.categoryMapping?.mercariShippingDays === 3, "発送日数保存直後の戻り値に選択した値(3)が載る");

  // ── 4. 配送料の負担を保存 ──────────────────────────────────────────
  const afterShippingPayer = await saveChannelOverride(
    EDIT_ID,
    "MERCARI_SHOPS",
    {
      categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariCategoryName: KNOWN_CATEGORY_NAME, mercariShippingDays: 3, mercariShippingPayer: 1 },
      overrideTitle: null,
      overrideDescription: null,
      overridePrice: null,
    },
    "e2e-verify@example.com",
  );
  assertTrue(afterShippingPayer.categoryMapping?.mercariShippingPayer === 1, "配送料の負担保存直後の戻り値に選択した値(1)が載る");

  // ── 5. 再読込(save→reload): 別呼び出しで取得し直しても同じ値 ────────
  const reloaded = await getChannelListing(EDIT_ID, "MERCARI_SHOPS");
  assertTrue(reloaded?.categoryMapping?.mercariCategoryId === KNOWN_CATEGORY_ID, "再読込してもcategoryIdが保存した値のまま");
  assertTrue(reloaded?.categoryMapping?.mercariShippingDays === 3, "再読込してもshippingDaysが保存した値のまま");
  assertTrue(reloaded?.categoryMapping?.mercariShippingPayer === 1, "再読込してもshippingPayerが保存した値のまま");

  assertTrue(e2eReadBoundaryLeaks.length === 0, `保存→再読込までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // ── 6. →CSV再生成: 保存した値がCSV行にそのまま載る ─────────────────
  e2eReadBoundaryLeaks.length = 0;
  const row = await buildExportRowForInventory(EDIT_ID);
  assertTrue(row.ok === true, "不足項目を埋めた後はCSV行の組み立てが成功する");
  if (row.ok) {
    assertTrue(row.fields.categoryId === KNOWN_CATEGORY_ID, "CSV行のcategoryIdが保存したcategoryIdと一致する");
    assertTrue(row.fields.shippingDays === 3, "CSV行のshippingDaysが保存した値(3)と一致する");
    assertTrue(row.fields.shippingPayer === 1, "CSV行のshippingPayerが保存した値(1)と一致する");
    const exported = buildMercariCsvExport([row.fields]);
    assertTrue(exported.ok === true, "CSV生成(バイト列組み立て)まで成功する");
  }
  assertTrue(e2eReadBoundaryLeaks.length === 0, `CSV生成までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // ── 6.5 task_ca862bd2a1f6fbf60d(2026-09-15)是正の本題: 送料別
  //        (mercariShippingPayer=2)を選ぶとCSV側は送料ID必須
  //        (validate.ts)なのに、送料IDを保存するUI/経路自体が無く常に
  //        ブロックされていた(e8報告の残課題)。送料ID保存→再読込
  //        →CSV再生成の一致と、送料込へ戻した時にCSVへ漏れないことを
  //        通しで確認する ──────────────────────────────────────────────
  e2eReadBoundaryLeaks.length = 0;
  const afterPayer2NoFeeId = await saveChannelOverride(
    EDIT_ID,
    "MERCARI_SHOPS",
    {
      categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariCategoryName: KNOWN_CATEGORY_NAME, mercariShippingDays: 3, mercariShippingPayer: 2 },
      overrideTitle: null,
      overrideDescription: null,
      overridePrice: null,
    },
    "e2e-verify@example.com",
  );
  assertTrue(afterPayer2NoFeeId.categoryMapping?.mercariShippingPayer === 2, "送料別への切替は送料ID未入力でも保存が成功する(途中空欄保存許可)");
  assertTrue(!afterPayer2NoFeeId.categoryMapping?.mercariShippingFeeId, "送料ID未入力のままの保存直後はmercariShippingFeeIdが未設定");

  const payer2Row = await buildExportRowForInventory(EDIT_ID);
  assertTrue(payer2Row.ok === true, "送料別+送料ID未入力でもCSV行の組み立て自体はブロックされない(必須チェックはCSV生成の最終段)");
  if (payer2Row.ok) {
    assertTrue(payer2Row.fields.shippingFeeId === null, "組み立てられた行のshippingFeeIdはnull(空文字列で捏造しない)");
    const blockedExport = buildMercariCsvExport([payer2Row.fields]);
    assertTrue(blockedExport.ok === false, "送料別+送料ID未入力のCSV生成は理由付きでブロックされる");
    if (!blockedExport.ok) {
      assertTrue(
        blockedExport.blockedRows.some((b) => b.reasons.some((r) => r.includes("送料ID"))),
        `ブロック理由に「送料ID」が含まれる(実際: ${JSON.stringify(blockedExport.blockedRows)})`,
      );
    }
  }
  assertTrue(e2eReadBoundaryLeaks.length === 0, `送料別+送料ID未入力のブロック確認までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // 空文字列の送料IDは保存自体を拒否する(未入力はundefinedで送る前提——
  // MercariCategoryMappingSection.tsxのtrim()||undefined参照)。
  e2eReadBoundaryLeaks.length = 0;
  await assertThrows(
    () =>
      saveChannelOverride(
        EDIT_ID,
        "MERCARI_SHOPS",
        {
          categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariShippingDays: 3, mercariShippingPayer: 2, mercariShippingFeeId: "" },
          overrideTitle: null,
          overrideDescription: null,
          overridePrice: null,
        },
        "e2e-verify@example.com",
      ),
    "送料IDに空文字列を明示的に渡す保存は拒否される",
  );
  const afterEmptyFeeIdRejection = await getChannelListing(EDIT_ID, "MERCARI_SHOPS");
  assertTrue(!afterEmptyFeeIdRejection?.categoryMapping?.mercariShippingFeeId, "空文字列拒否後も送料IDは未設定のまま(壊れた値が書き込まれない)");
  assertTrue(e2eReadBoundaryLeaks.length === 0, `送料ID空文字列拒否までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // 送料IDを入力・保存(既存のカテゴリー/発送日数/配送料負担は保持)。
  e2eReadBoundaryLeaks.length = 0;
  const FEE_ID = "fee-edit-900001";
  const afterFeeId = await saveChannelOverride(
    EDIT_ID,
    "MERCARI_SHOPS",
    {
      categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariCategoryName: KNOWN_CATEGORY_NAME, mercariShippingDays: 3, mercariShippingPayer: 2, mercariShippingFeeId: FEE_ID },
      overrideTitle: null,
      overrideDescription: null,
      overridePrice: null,
    },
    "e2e-verify@example.com",
  );
  assertTrue(afterFeeId.categoryMapping?.mercariShippingFeeId === FEE_ID, "送料ID保存直後の戻り値に入力したIDがそのまま載る");

  const reloadedWithFeeId = await getChannelListing(EDIT_ID, "MERCARI_SHOPS");
  assertTrue(reloadedWithFeeId?.categoryMapping?.mercariShippingFeeId === FEE_ID, "再読込しても送料IDが保存した値のまま");
  assertTrue(e2eReadBoundaryLeaks.length === 0, `送料ID保存→再読込までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  e2eReadBoundaryLeaks.length = 0;
  const payer2RowWithFeeId = await buildExportRowForInventory(EDIT_ID);
  assertTrue(payer2RowWithFeeId.ok === true, "送料ID入力済みならCSV行の組み立てが成功する");
  if (payer2RowWithFeeId.ok) {
    assertTrue(payer2RowWithFeeId.fields.shippingFeeId === FEE_ID, "CSV行のshippingFeeIdが保存した実値と一致する");
    const exportedWithFeeId = buildMercariCsvExport([payer2RowWithFeeId.fields]);
    assertTrue(exportedWithFeeId.ok === true, "送料別+送料ID入力済みならCSV生成(バイト列組み立て)まで成功する");
  }
  assertTrue(e2eReadBoundaryLeaks.length === 0, `送料ID入力済みでのCSV生成までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // 送料込(1)へ戻す。指示書§4「送料込への切替ではCSVにIDを出さない」——
  // MercariCategoryMappingSection.tsxのsaveShippingPayer()と同じく、
  // mercariShippingFeeId自体は保存済みの値をそのまま引き継ぐ(消さない)。
  e2eReadBoundaryLeaks.length = 0;
  const afterBackToPayer1 = await saveChannelOverride(
    EDIT_ID,
    "MERCARI_SHOPS",
    {
      categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariCategoryName: KNOWN_CATEGORY_NAME, mercariShippingDays: 3, mercariShippingPayer: 1, mercariShippingFeeId: FEE_ID },
      overrideTitle: null,
      overrideDescription: null,
      overridePrice: null,
    },
    "e2e-verify@example.com",
  );
  assertTrue(afterBackToPayer1.categoryMapping?.mercariShippingPayer === 1, "送料込へ戻す保存が成功する");
  assertTrue(afterBackToPayer1.categoryMapping?.mercariShippingFeeId === FEE_ID, "送料込へ戻しても送料IDそのものはmapping上に残る(消さない設計)");

  const payer1RowWithStaleFeeId = await buildExportRowForInventory(EDIT_ID);
  assertTrue(payer1RowWithStaleFeeId.ok === true, "送料込+送料ID残存でもCSV行の組み立ては成功する");
  if (payer1RowWithStaleFeeId.ok) {
    assertTrue(payer1RowWithStaleFeeId.fields.shippingFeeId === null, "送料込に戻すと、mappingに送料IDが残っていてもCSV行のshippingFeeIdはnull(漏れない)");
    const exportedPayer1 = buildMercariCsvExport([payer1RowWithStaleFeeId.fields]);
    assertTrue(exportedPayer1.ok === true, "送料込では送料ID不要のためCSV生成が成功する");
  }
  assertTrue(e2eReadBoundaryLeaks.length === 0, `送料込復帰の確認までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // 以降の既存検証(shippingDays=3/shippingPayerの前提)と衝突しないよう、
  // ここまでで組み立てたEDIT_IDの状態(shippingPayer=1)を保ったまま次へ進む。

  // ── 7. 不正値拒否: shippingDaysが範囲外だと保存自体が拒否され、状態は変わらない ──
  e2eReadBoundaryLeaks.length = 0;
  await assertThrows(
    () =>
      saveChannelOverride(
        EDIT_ID,
        "MERCARI_SHOPS",
        { categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariShippingDays: 99 as never }, overrideTitle: null, overrideDescription: null, overridePrice: null },
        "e2e-verify@example.com",
      ),
    "shippingDays=99(範囲外)は保存が拒否される",
  );
  await assertThrows(
    () =>
      saveChannelOverride(
        EDIT_ID,
        "MERCARI_SHOPS",
        { categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariShippingPayer: 9 as never }, overrideTitle: null, overrideDescription: null, overridePrice: null },
        "e2e-verify@example.com",
      ),
    "shippingPayer=9(範囲外)は保存が拒否される",
  );
  await assertThrows(
    () => saveChannelOverride(EDIT_ID, "MERCARI_SHOPS", { categoryMapping: null, overrideTitle: null, overrideDescription: null, overridePrice: -100 }, "e2e-verify@example.com"),
    "overridePrice=-100(負の値)は保存が拒否される",
  );
  const afterRejections = await getChannelListing(EDIT_ID, "MERCARI_SHOPS");
  assertTrue(afterRejections?.categoryMapping?.mercariShippingDays === 3, "不正値の保存試行後もshippingDaysは直前の正常値(3)のまま変わらない");
  assertTrue(e2eReadBoundaryLeaks.length === 0, `不正値拒否までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // ── 8. 保存失敗(実運用の保存障害を模す): 例外が飛び、状態が変わらない ──
  e2eReadBoundaryLeaks.length = 0;
  const beforeFail = await getChannelListing(E2E_MERCARI_CSV_SAVE_FAIL_ID, "MERCARI_SHOPS");
  await assertThrows(
    () =>
      saveChannelOverride(
        E2E_MERCARI_CSV_SAVE_FAIL_ID,
        "MERCARI_SHOPS",
        { categoryMapping: { mercariCategoryId: KNOWN_CATEGORY_ID, mercariShippingDays: 5, mercariShippingPayer: 2 }, overrideTitle: null, overrideDescription: null, overridePrice: null },
        "e2e-verify@example.com",
      ),
    "保存が常に失敗する合成商品では、saveChannelOverrideが例外を投げる",
  );
  const afterFail = await getChannelListing(E2E_MERCARI_CSV_SAVE_FAIL_ID, "MERCARI_SHOPS");
  assertTrue(JSON.stringify(afterFail) === JSON.stringify(beforeFail), "保存失敗後も状態(categoryMapping等)は保存試行前と完全に同じ(サーバー側で何も書き換わっていない)");
  assertTrue(e2eReadBoundaryLeaks.length === 0, `保存失敗経路もSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // ── 9. 価格不正拒否: 下書き価格が300円未満だとCSV生成(exportMercariShopsCsvAction
  //      と同じ2段構成——行の組み立て自体はassembleRow.tsで丸めず素通し
  //      し、範囲チェックはvalidateMercariCsvRow(validate.ts、
  //      buildMercariCsvExport経由)側で行う設計、assembleRow.tsコメント参照)
  //      がブロックされる ──
  e2eReadBoundaryLeaks.length = 0;
  const invalidPriceRow = await buildExportRowForInventory(E2E_MERCARI_CSV_INVALID_PRICE_ID);
  assertTrue(invalidPriceRow.ok === true, "行の組み立て自体(価格を丸めない素通し)はここでは成功する");
  if (invalidPriceRow.ok) {
    assertTrue(invalidPriceRow.fields.salePrice === 100, "組み立てられた行にはCSV下限(300円)未満の下書き価格がそのまま(丸めずに)載る");
    const exported = buildMercariCsvExport([invalidPriceRow.fields]);
    assertTrue(exported.ok === false, "CSV生成(buildMercariCsvExport)の段でブロックされる(黙って除外しない)");
    assertTrue(
      exported.blockedRows.some((b) => b.reasons.some((r) => r.includes("価格"))),
      `ブロック理由に価格関連の記述が含まれる(実際: ${JSON.stringify(exported.blockedRows)})`,
    );
  }
  assertTrue(e2eReadBoundaryLeaks.length === 0, `価格不正拒否経路もSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  // ── 10. task_e8b97d6b40aad90fff(2026-09-15)是正: BASEにMercari制約を
  //        適用しない/channelとテストsessionでMapを分離する(合成保存
  //        状態がchannelを跨いで漏れない) ──────────────────────────────
  e2eReadBoundaryLeaks.length = 0;
  // BASEはmercariCategoryId等のMercari専用フィールドを検証しない——
  // 範囲外のshippingDays(99)を混ぜても拒否されない(BASEは
  // categoryMapping自体を使わないapp/actions/listing.tsのBASE用Actionが
  // 常にnullを送るのが実運用だが、ここではchannel引数だけでMercari制約が
  // 出し分けられていることを直接確認する)。
  const baseOverride = await saveChannelOverride(
    EDIT_ID,
    "BASE",
    { categoryMapping: { mercariCategoryId: "", mercariShippingDays: 99 as never }, overrideTitle: "BASE用タイトル", overrideDescription: null, overridePrice: null },
    "e2e-verify@example.com",
  );
  assertTrue(baseOverride.channel === "BASE", "BASEチャネルの保存はchannel:BASEのレコードを返す(Mercari制約で拒否されない)");
  const mercariAfterBaseSave = await getChannelListing(EDIT_ID, "MERCARI_SHOPS");
  assertTrue(mercariAfterBaseSave?.categoryMapping?.mercariCategoryId === KNOWN_CATEGORY_ID, "同じinventoryIdへのBASE保存後もMERCARI_SHOPS側のcategoryMappingは変わらない(channel別に分離されている)");
  const baseReloaded = await getChannelListing(EDIT_ID, "BASE");
  assertTrue(baseReloaded?.channel === "BASE" && baseReloaded?.overrideTitle === "BASE用タイトル", "BASE側を再取得してもBASE自身の保存値がそのまま返る");
  assertTrue(e2eReadBoundaryLeaks.length === 0, `channel分離の確認までSDK到達ゼロ(検出内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
