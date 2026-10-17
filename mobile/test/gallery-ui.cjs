const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const output = process.env.MOBILE_UI_PROOF_DIR;
  if (!output) throw Error('MOBILE_UI_PROOF_DIR is required');
  const png = await fs.readFile(path.join(__dirname, '../../public/bello-system-icon.png'));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, width, height] of [['phone', 390, 844], ['tablet', 820, 1180], ['desktop', 1280, 900]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const originals = [];
      await page.route('https://bello-preview.invalid/**', route => { if (route.request().url().includes('/full/')) originals.push(route.request().url()); return route.fulfill({ contentType: 'image/png', body: png }); });
      await page.goto('http://localhost:8097/?gallery-test=1', { waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: '在庫一覧', exact: true }).click();
      await page.getByRole('button', { name: 'ダイニングチェア / ナチュラルウッド、数量11', exact: true }).click();
      await expect(page.getByText('合計 33枚', { exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: '商品画像 30枚', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^商品画像\d+を拡大$/ })).toHaveCount(24);
      await expect(page.getByRole('button', { name: '残り6枚を表示', exact: true })).toHaveCount(1);
      if (name === 'phone') { await page.getByText('合計 33枚', { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'gallery-phone.png') }); }
      await page.getByRole('button', { name: '残り6枚を表示', exact: true }).click();
      await expect(page.getByRole('button', { name: /^商品画像\d+を拡大$/ })).toHaveCount(30);
      assertNoOriginals(originals);
      await page.getByRole('button', { name: '商品画像30を拡大', exact: true }).click();
      await expect(page.getByText('30 / 30', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '次の画像', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: '前の画像', exact: true }).click();
      await expect(page.getByText('29 / 30', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '画像を閉じる', exact: true }).click();
      await page.getByRole('tab', { name: '傷・状態 3枚', exact: true }).click();
      await expect(page.getByRole('button', { name: /^傷・状態\d+を拡大$/ })).toHaveCount(3);
      await page.close();
    }
    console.log('PASS: phone/tablet/desktop gallery counts, 30 product + 3 damage images, paging, full-image on demand and viewer navigation; synthetic fixtures only.');
  } finally { await browser.close(); }
}
function assertNoOriginals(values) { if (values.length) throw Error('Original images were fetched before expansion'); }
main().catch(error => { console.error(error); process.exitCode = 1; });
