import { test, expect, type Page } from "@playwright/test";

/**
 * 2026-09-14 指示書レビュー修正: EC出品個別編集画面(app/inventory/
 * (protected)/[id]/listing/ListingForm.tsx)の「出品内容をコピー
 * （手動出品用）」ボタンとAutoPricingSectionのmanual-only注記を、
 * 実際にクリック操作を伴うPlaywrightで確かめる。
 *
 * 【なぜ専用idが要るか】どちらの要素も「下書き(ListingDraft)と
 * ChannelListing(MERCARI_SHOPS)が既に存在する」商品でしか描画されない
 * (ボタンはdisabled={!draft}、AutoPricingSectionは
 * {channelListing && (...)})。従来のE2E fixture(lib/listing/service.ts
 * のgetListingDraftForInventory/getChannelListing)はfixtureモードでは
 * 商品を問わず常にnullを返していたため、この2つを実ブラウザで検証する
 * 経路自体が無かった——lib/inventory/e2eFixtures.tsに追加した専用商品
 * e2e-inv-30(lib/listing/e2eFixtures.tsのe2eManualOnlyListingDraft/
 * e2eManualOnlyChannelListing)だけ合成の下書き・ChannelListingを持つ。
 * 他の商品(e2e-inv-1等)は従来通り「下書き無し」のままで、既存のE2E
 * (listing-layout.spec.ts等)には影響しない。
 *
 * clipboard書き込みの権限(navigator.clipboard.writeText)はこの
 * describeブロック内でのみ付与する(グローバル設定は変更しない)。
 */

const E2E_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
const INVENTORY_ID = "e2e-inv-30";
const LISTING_URL = `/inventory/${INVENTORY_ID}/listing`;

async function signIn(page: Page) {
  await page.context().addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${E2E_TOKEN}`, url: "http://127.0.0.1:3100" }]);
}

test.describe("EC出品個別編集画面: manual-only運用のUI(§9レビュー指摘対応)", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("Mercariに出品するボタンは無効、出品内容をコピーは有効でクリックするとclipboardへ書き込まれる", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto(LISTING_URL);
    await expect(page.getByRole("heading", { name: "EC出品" })).toBeVisible();

    const publishButton = page.getByRole("button", { name: "Mercariに出品する" });
    const copyButton = page.getByRole("button", { name: "出品内容をコピー（手動出品用）" });

    // ★要件: この運用ではAPI送信を行わないので、出品ボタンは無効化
    // されたまま——TOKEN保存・接続確認(verified)の値に関わらず。
    await expect(publishButton).toBeDisabled();
    await expect(page.getByText("現在の運用では出品ボタンは無効化されています", { exact: false })).toBeVisible();

    // ★要件: 手動出品支援(コピー)は下書きさえあれば常に使える。
    await expect(copyButton).toBeEnabled();
    await copyButton.click();
    await expect(page.getByText("コピーしました")).toBeVisible();

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText, "コピー内容にタイトル見出しが含まれる").toContain("【タイトル】");
    expect(clipboardText, "コピー内容に価格見出しが含まれる").toContain("【価格】");
    expect(clipboardText, "コピー内容に説明文見出しが含まれる").toContain("【説明文】");
  });

  test("自動価格設定(AutoPricingSection)はmanual-only運用の注記を表示する", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto(LISTING_URL);
    await expect(page.getByText("自動価格設定")).toBeVisible();

    // ★要件: 判定・記録機能自体は無効化しない(チェックボックス操作は可能)
    // が、Mercariへは反映されないことを常に明示する。
    await expect(
      page.getByText("現在の運用ではMercariへの自動出品・自動値下げ（API送信）は行っていません。", { exact: false }),
    ).toBeVisible();

    const checkbox = page.getByRole("checkbox", { name: "この商品に自動価格ルールを適用する" });
    await expect(checkbox).toBeEnabled();
  });
});
