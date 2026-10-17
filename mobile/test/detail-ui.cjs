const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  const target = process.env.MOBILE_UI_PROOF_DIR;
  if (!target) throw new Error('MOBILE_UI_PROOF_DIR is required.');
  await fs.mkdir(target, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const captureAt = async (label, file) => {
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
      await page.getByLabel(label, { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(target, file) });
    };
    await page.goto('http://localhost:8097/', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '在庫一覧', exact: true }).click();
    await page.getByRole('button', { name: 'ダイニングチェア / ナチュラルウッド、数量11', exact: true }).click();
    await page.getByRole('button', { name: '編集', exact: true }).click();
    await expect(page.getByLabel('数量', { exact: true })).toHaveValue('11');
    await expect(page.getByLabel('数量（仕入）', { exact: true })).toHaveValue('3');
    await expect(page.getByLabel('販売予定価格（送料別）', { exact: true })).toHaveValue('29800');
    await expect(page.getByLabel('購入価格', { exact: true })).toHaveValue('5940');
    await expect(page.getByRole('button', { name: '状態', exact: true })).toContainText('目立った傷や汚れなし');
    await page.getByRole('button', { name: '状態', exact: true }).click();
    await page.getByRole('button', { name: 'やや傷や汚れあり', exact: true }).click();
    await expect(page.getByRole('button', { name: '状態', exact: true })).toContainText('やや傷や汚れあり');
    await expect(page.getByLabel('コンディション評価（1〜5の5段階で）', { exact: true })).toHaveValue('3.5');
    await expect(page.getByLabel('送料（保存済みの参考値）', { exact: true })).not.toBeEditable();
    await page.screenshot({ path: path.join(target, 'editor-basic.png') });
    await page.getByLabel('奥行（cm）', { exact: true }).fill('55.5');
    await page.getByRole('button', { name: '全長調節可否', exact: true }).click();
    await page.getByRole('button', { name: '可', exact: true }).click();
    await captureAt('幅（cm）', 'editor-dimensions.png');
    await page.getByLabel('購入価格', { exact: true }).fill('6500');
    await captureAt('購入価格', 'editor-purchase.png');
    await page.getByLabel('販売価格', { exact: true }).fill('31000');
    await page.getByLabel('出品情報', { exact: true }).fill('画面試験で変更した出品情報');
    await page.getByLabel('市川メモ', { exact: true }).fill('圏外でも保持するメモ');
    await captureAt('出品情報', 'editor-sales.png');
    await page.getByRole('button', { name: '圏外を試す', exact: true }).click();
    await page.getByRole('button', { name: '完了', exact: true }).click();
    await expect(page.getByText('【圏外です】', { exact: true })).toBeVisible();
    await expect(page.getByLabel('市川メモ', { exact: true })).toHaveValue('圏外でも保持するメモ');
    await page.getByRole('button', { name: '一覧へ戻る', exact: true }).click();
    await page.getByRole('button', { name: '変更を保存する', exact: true }).click();
    await expect(page.getByText('変更内容をどうしますか？')).toBeVisible();
    await page.getByRole('button', { name: '編集を続ける', exact: true }).click();
    await page.getByRole('button', { name: '通信を戻す', exact: true }).click();
    await page.getByRole('button', { name: '完了', exact: true }).click();
    await page.getByRole('button', { name: 'ダイニングチェア / ナチュラルウッド、数量11', exact: true }).click();
    await expect(page.getByText('55.5', { exact: true })).toHaveCount(1);
    await expect(page.getByText('31000', { exact: true })).toHaveCount(1);
    await expect(page.getByText('圏外でも保持するメモ', { exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '表示確認アカウントを切り替え', exact: true }).click();
    await expect(page.getByText('販売価格', { exact: true })).toHaveCount(0);
    await expect(page.getByText('出品情報', { exact: true })).toHaveCount(0);
    await expect(page.getByText('31000', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '編集', exact: true }).click();
    await expect(page.getByLabel('販売価格', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('出品情報', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('奥行（cm）', { exact: true })).toHaveValue('55.5');
    await fs.writeFile(path.join(target, 'detail-ui-result.json'), JSON.stringify({ passed: true, mode: 'React Native Web preview, synthetic data only', additionalFields: 35, confirmed: ['distinct inventory/purchase quantity', 'distinct planned/purchase/sale price', 'state separate from condition rating', 'decimal dimensions', 'explicit selection', 'offline retained detail edits', 'offline leave-save blocked', 'explicit save and readback', 'staff hides sales and listing data'], nativeDeviceVerified: false, productionVerified: false }, null, 2));
    console.log('PASS: complete detail editor preview, offline retention, saved detail readback and staff restrictions; synthetic data only.');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
