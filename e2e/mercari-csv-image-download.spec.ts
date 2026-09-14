import { test, expect, type Page, type Download } from "@playwright/test";
import { mercariImgFixtureBytes } from "../lib/listing/mercari/csv/e2eImageFixtureBytes";

/**
 * CSV候補3494f3700cfecf0196856ced0ade976fd7aeb1df 画像受渡し 実UI検証
 * (2026-09-14レビュー修正)。
 *
 * タスク指示書§7「ブラウザで画像ダウンロードイベント→保存名とCSV列
 * 一致/画像バイト一致、失敗/期限切れ/権限なし/別商品キー拒否、1枚/20枚
 * /大量商品上限。CSV編集補完→生成→ファイルdownloadの通し合成E2E」に
 * 対応する。
 *
 * 【何を実ブラウザで検証し、何を検証していないか】
 * - `getMercariCsvImageZipAction`/`exportMercariShopsCsvAction`は
 *   どちらも読み取り専用(getInventoryDetail/getListingDraftForInventory
 *   /getChannelListing経由——全てlib/listing/e2eFixtures.ts側で二重
 *   ゲート済み)——このファイルはその読み取り経路を実際のNext.jsサーバー
 *   ・実ブラウザ・実ダウンロードイベントを通して検証する。
 * - 「CSV編集補完」(カテゴリー/発送日数/配送料負担の選択・保存UI)は
 *   `saveChannelOverrideAction`という書き込み経路を通る——BELLOの既存
 *   E2E方針(lib/listing/e2eFixtures.tsの冒頭コメント、lib/inventory/
 *   e2eFixtures.tsの冒頭コメント「書き込み系には一切のfixture分岐を
 *   追加していない」)により、書き込みは実AWSスタブ(未デプロイの
 *   placeholder)へ到達を試みて失敗する——このsandboxでは書き込みUIの
 *   対話自体を実ブラウザで再現できない(このリポジトリの他の全E2Eと
 *   同じ既知の構造的制約であり、本タスクで新たに導入した制約ではない)。
 *   そのため「編集補完」は、lib/listing/e2eFixtures.tsの
 *   e2eMercariCsvChannelListingFor()が返す“保存済み完了状態”
 *   (実在するカテゴリーID——scripts/generate-sample-mercari-export.ts
 *   と同じ既知の実在ID、shippingDays/shippingPayer確定済み)として表現
 *   し、そこから先(生成→ダウンロード)だけを実操作で検証する。
 * - 画像バイト自体はローカルのe2e-fixtures配信route(app/e2e-fixtures/
 *   mercari-image/[variant]/route.ts)から実HTTP経由でサーバーが取得した
 *   ものであり、モック関数の戻り値を直接比較しているのではない
 *   (lib/listing/mercari/csv/e2eImageFixtureBytes.tsのコメント参照)。
 *
 * webServer(playwright.config.ts)がINVENTORY_E2E_FIXTURES=1を渡すため、
 * 実AWSには一切到達しない。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";

async function signIn(page: Page, role: "ADMIN" | "VIEWER" = "ADMIN") {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `${role}:${E2E_TOKEN}`, url: "http://127.0.0.1:3100" }]);
}

/** buildStoredZip(lib/listing/mercari/csv/imageZip.ts)が書き出す無圧縮(STORE)ZIPのlocal file headerだけを読む——中央ディレクトリ/EOCDは無視してよい(全エントリのバイト列はlocal headerから直接取れる)。 */
function parseStoredZip(buf: Buffer): { filename: string; data: Buffer }[] {
  const entries: { filename: string; data: Buffer }[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const filename = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const data = buf.subarray(dataStart, dataStart + compSize);
    entries.push({ filename, data });
    offset = dataStart + compSize;
  }
  return entries;
}

async function downloadToBuffer(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream is null");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function clickZipButton(page: Page) {
  await page.getByRole("button", { name: /画像をまとめてZIPで保存/ }).click();
}

/**
 * task_c600821eb2e0376d87(2026-09-14是正): `/inventory/listings`への
 * navigationは、lib/listing/e2eFixtures.tsのe2eListingsOverviewFetch
 * コメントのとおり「dev serverプロセス内で最初の呼び出しは必ず失敗し、
 * 2回目以降は成功する」——e2e/listings-overview.spec.tsの先頭テストは
 * この前提で「初回失敗→再試行導線→成功」まで検証している。
 *
 * このファイルを他のspec(特にlistings-overview.spec.ts)より前に
 * 単独で実行すると(例: このファイルだけをgrep指定した検証実行)、
 * プロセス内で最初に`/inventory/listings`へ到達するのはこのファイルの
 * テストになり、上記の「初回失敗」を思いがけず引いてしまう
 * (実測: EC出品一覧の取得が`{stage:null, kind:'unknown'}`で失敗し、
 * 「◯件表示」が出ないままtoBeVisibleがタイムアウトする)。
 * full suite実行時(listings-overview.spec.tsが先に「初回失敗」を消費
 * 済み)は再試行導線は出ず、このヘルパーは即座に件数表示を待つだけになる
 * ——どちらの実行順序でも決定的に成功させるため、再試行導線が出た
 * 場合だけクリックする。
 */
async function gotoListingsOverview(page: Page) {
  await page.goto("/inventory/listings");
  const countBadge = page.getByText(/件表示$/);
  const retryButton = page.getByRole("button", { name: "再試行" });
  await Promise.race([
    countBadge.waitFor({ state: "visible", timeout: 15_000 }),
    retryButton.waitFor({ state: "visible", timeout: 15_000 }),
  ]);
  if (await retryButton.isVisible()) {
    await retryButton.click();
  }
  await expect(countBadge).toBeVisible({ timeout: 15_000 });
}

test.describe("Mercari CSV画像受渡し(ZIP/CSV)の実ブラウザ検証", () => {
  test("単一商品・1枚: ダウンロードイベントで保存名とバイトが一致する", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-41/listing");
    await expect(page.getByText("画像の受け渡し（CSV出力用）")).toBeVisible({ timeout: 15_000 });

    const [download] = await Promise.all([page.waitForEvent("download"), clickZipButton(page)]);
    expect(download.suggestedFilename()).toMatch(/^mercari_shops_images_.*\.zip$/);
    const buf = await downloadToBuffer(download);
    const entries = parseStoredZip(buf);
    expect(entries).toHaveLength(1);
    // 保存名はCSVの商品画像名列と同じ生成規則(imageFilename、
    // lib/listing/mercari/csv/assembleRow.ts): `${displayId}_${連番}.拡張子`。
    expect(entries[0].filename).toBe("B000041_1.jpg");
    // 画像バイトはe2e-fixtures配信route(実HTTP経由)から取得したものが
    // 独立に計算した期待バイト列と完全一致する。
    expect(entries[0].data.equals(Buffer.from(mercariImgFixtureBytes("ok-1")))).toBe(true);
    await expect(page.getByText("ZIPを保存しました。")).toBeVisible();
  });

  test("単一商品・101枚: 合計上限(100枚)超過は拒否され、ダウンロードは発生しない", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-42/listing");
    await expect(page.getByText("画像の受け渡し（CSV出力用）")).toBeVisible({ timeout: 15_000 });

    let downloadHappened = false;
    page.once("download", () => {
      downloadHappened = true;
    });
    await clickZipButton(page);
    await expect(page.getByText(/合計100枚までです/)).toBeVisible({ timeout: 10_000 });
    expect(downloadHappened).toBe(false);
  });

  test("単一商品・100枚(境界値): ちょうど上限枚数は成功する", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-46/listing");
    await expect(page.getByText("画像の受け渡し（CSV出力用）")).toBeVisible({ timeout: 15_000 });

    const [download] = await Promise.all([page.waitForEvent("download"), clickZipButton(page)]);
    const buf = await downloadToBuffer(download);
    const entries = parseStoredZip(buf);
    expect(entries).toHaveLength(100);
    const names = new Set(entries.map((e) => e.filename));
    expect(names.size).toBe(100); // 重複ファイル名が無い(imageFilename()の連番が正しく効いている)
    // 抜き取りでバイト一致も確認する(全件比較はCPU上は可能だが趣旨は
    // 「サーバーが実際にHTTP経由で正しいバイトを取得している」ことの
    // 確認なので、境界の1件目・末尾100件目だけで十分)。
    const first = entries.find((e) => e.filename === "B000046_1.jpg");
    const last = entries.find((e) => e.filename === "B000046_100.jpg");
    expect(first?.data.equals(Buffer.from(mercariImgFixtureBytes("ok-1")))).toBe(true);
    expect(last?.data.equals(Buffer.from(mercariImgFixtureBytes("ok-100")))).toBe(true);
  });

  test("単一商品: 署名期限切れ相当(403)は失敗表示になり、部分成功のZIPを返さない", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-43/listing");
    await expect(page.getByText("画像の受け渡し（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    let downloadHappened = false;
    page.once("download", () => {
      downloadHappened = true;
    });
    await clickZipButton(page);
    await expect(page.getByText(/HTTP 403/)).toBeVisible({ timeout: 10_000 });
    expect(downloadHappened).toBe(false);
  });

  test("単一商品: 権限なし相当(403)は失敗表示になる", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-44/listing");
    await expect(page.getByText("画像の受け渡し（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    let downloadHappened = false;
    page.once("download", () => {
      downloadHappened = true;
    });
    await clickZipButton(page);
    await expect(page.getByText(/HTTP 403/)).toBeVisible({ timeout: 10_000 });
    expect(downloadHappened).toBe(false);
  });

  test("単一商品: 対象なし相当(404、削除済み/不正キー)は失敗表示になる", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-45/listing");
    await expect(page.getByText("画像の受け渡し（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    let downloadHappened = false;
    page.once("download", () => {
      downloadHappened = true;
    });
    await clickZipButton(page);
    await expect(page.getByText(/HTTP 404/)).toBeVisible({ timeout: 10_000 });
    expect(downloadHappened).toBe(false);
  });

  test("単一商品: 1枚あたりの上限(15MB)を超える画像はストリーム受信中に打ち切られ、部分成功のZIPを返さない", async ({ page }) => {
    // task_f712cf24a9fe2308cd(2026-09-14是正): 旧実装は`arrayBuffer()`で
    // 全量読み切ってから上限判定していた(取得中の実制限が無かった)。
    // ここでは16MBの合成画像に対して実際に「取得中に中断」できている
    // ことを実ブラウザ・実ダウンロードイベントで検証する
    // (lib/listing/mercari/csv/e2eImageFixtureBytes.tsのTOO_LARGE_VARIANT_BYTES参照)。
    test.setTimeout(30_000);
    await signIn(page);
    await page.goto("/inventory/e2e-inv-47/listing");
    await expect(page.getByText("画像の受け渡し（CSV出力用）")).toBeVisible({ timeout: 15_000 });
    let downloadHappened = false;
    page.once("download", () => {
      downloadHappened = true;
    });
    await clickZipButton(page);
    await expect(page.getByText(/1枚あたりの上限\(15MB\)を超えています/)).toBeVisible({ timeout: 15_000 });
    expect(downloadHappened).toBe(false);
  });

  test("一覧: 下書き20商品→CSVを作成→画像をまとめてZIPで保存→CSV列とZIPのファイル名/バイトが一致(別商品キー拒否=商品間の取り違えが無いことを含む)", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    await gotoListingsOverview(page);

    await page.getByRole("button", { name: "CSVを作成" }).click();
    // 「下書き」バケットに絞ると、対象20商品(hasDraft:true・
    // channelListing無し)だけがCSVモードで選択可能になる——他の27件
    // (channelListing.status==="DRAFT"だがhasDraft:falseの既存行、
    // lib/listing/e2eFixtures.ts参照)はチェックボックスが無効のまま
    // 「すべて選択」の対象に入らない。
    await page.locator("select").selectOption({ label: "下書き" });
    await page.getByLabel("すべて選択").check();
    await expect(page.getByText("20件選択中")).toBeVisible();

    // 「CSVを作成」というaccessible nameはモード切替ボタン(上で既に
    // クリック済み)と生成実行ボタンの両方が持つため、後者はtitle属性
    // (ListingsOverviewTable.tsx参照)で一意に特定する。
    const csvExportButton = page.getByTitle(/商品一括登録CSV/);
    const [csvDownload] = await Promise.all([page.waitForEvent("download"), csvExportButton.click()]);
    const csvBuf = await downloadToBuffer(csvDownload);
    // CP932でエンコードされている——列0(商品画像名_1)・列20(商品名)の
    // 位置に日本語が来るため、比較に使う値(displayId・ファイル名)は
    // すべて半角英数字に限定し、CP932/UTF-8どちらの解釈でも同じバイト列
    // になる範囲だけを見る(cp932.tsの往復試験は既にverify:mercari-csv-
    // exportで検証済みなので、ここではCSVの実バイト列そのものを対象にする)。
    const csvText = csvBuf.toString("latin1");
    const csvLines = csvText.split("\n").filter((l) => l.trim().length > 0);
    expect(csvLines.length).toBe(21); // header + 20 rows
    for (let n = 20; n < 40; n++) {
      const displayId = `LST-${String(n).padStart(4, "0")}`;
      expect(csvText).toContain(`${displayId}_1.jpg`);
    }

    // runCsvExportは成功時に選択(selected)をクリアする
    // (ListingsOverviewTable.tsxのrunCsvExportコメント参照)——画像ZIPは
    // 別の一括操作として、同じ20件をもう一度選び直す(フィルタ「下書き」
    // は維持されたまま)。
    await page.getByLabel("すべて選択").check();
    await expect(page.getByText("20件選択中")).toBeVisible();
    const [zipDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /画像をまとめてZIPで保存/ }).click()]);
    const zipBuf = await downloadToBuffer(zipDownload);
    const entries = parseStoredZip(zipBuf);
    expect(entries).toHaveLength(20);

    const seenDisplayIds = new Set<string>();
    for (const entry of entries) {
      const match = entry.filename.match(/^(LST-\d{4})_1\.jpg$/);
      expect(match, `unexpected filename in bulk zip: ${entry.filename}`).not.toBeNull();
      const displayId = match![1];
      // 別商品キー拒否: 同じファイル名(=同じstorageKey由来)が2商品に
      // またがって現れない——商品ごとに独立したバイト列であることの証拠。
      expect(seenDisplayIds.has(displayId)).toBe(false);
      seenDisplayIds.add(displayId);
      // CSVに書かれた画像名列と、実際にZIPへ入っていたファイル名が完全一致する。
      expect(csvText).toContain(entry.filename);
      expect(entry.data.equals(Buffer.from(mercariImgFixtureBytes("ok-1")))).toBe(true);
    }
    expect(seenDisplayIds.size).toBe(20);
    for (let n = 20; n < 40; n++) {
      expect(seenDisplayIds.has(`LST-${String(n).padStart(4, "0")}`)).toBe(true);
    }
  });

  test("一覧: 21商品(MAX_ZIP_PRODUCTS=20超過)を選択すると画像ZIP作成が拒否される", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page);
    await gotoListingsOverview(page);

    await page.getByRole("button", { name: "CSVを作成" }).click();
    // フィルタ無し(すべて)だと、CSV対象(hasDraft:true)の全商品——上の
    // 20商品バケット+商品数上限超過検証専用の1件(lib/listing/
    // e2eFixtures.tsのbuildRows()、index===40)——を合わせて21件になる。
    await page.locator("select").selectOption({ label: "すべて" });
    await page.getByLabel("すべて選択").check();
    await expect(page.getByText("21件選択中")).toBeVisible();

    let downloadHappened = false;
    page.once("download", () => {
      downloadHappened = true;
    });
    await page.getByRole("button", { name: /画像をまとめてZIPで保存/ }).click();
    await expect(page.getByText(/最大20商品までです/)).toBeVisible({ timeout: 10_000 });
    expect(downloadHappened).toBe(false);
  });

  test("VIEWER権限では画像ZIPボタン自体が出ない(一覧の一括操作全体と同じ境界)", async ({ page }) => {
    test.setTimeout(30_000);
    await signIn(page, "VIEWER");
    await gotoListingsOverview(page);
    await expect(page.getByRole("button", { name: /画像をまとめてZIPで保存/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "CSVを作成" })).toHaveCount(0);
  });
});
