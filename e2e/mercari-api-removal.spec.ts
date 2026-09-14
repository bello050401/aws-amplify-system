import { test, expect } from '@playwright/test';
const token = 'e2e-local-test-token-not-a-real-secret-32c';
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
test.beforeEach(async ({context, baseURL}) => {
  await context.addCookies([{name:'__inv_e2e_role',value:`ADMIN:${token}`,url:baseURL!}]);
});
test('API出品を撤去し手動コピーを保持', async ({page}) => {
  await page.goto('/inventory/e2e-inv-30/listing');
  await expect(page.getByRole('heading',{name:'EC出品'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Mercariに出品する'})).toHaveCount(0);
  await expect(page.getByText('自動価格設定',{exact:true})).toHaveCount(0);
  const copy=page.getByRole('button',{name:'出品内容をコピー（手動出品用）'});
  await expect(copy).toBeEnabled(); await copy.click();
  const text=await page.evaluate(()=>navigator.clipboard.readText());
  expect(text).toContain('【タイトル】'); expect(text).toContain('【説明文】');
});
test('Mercari接続設定撤去とBASE設定保持', async ({page}) => {
  await page.goto('/inventory/settings?tab=mercari');
  await expect(page.getByRole('button',{name:'EC出品（Mercari）'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'カテゴリ',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'BASE連携',exact:true}).click();
  await expect(page.getByText('接続済み。特集ページ作成機能と商品説明分析機能は、この同じ接続を共用します',{exact:false})).toBeVisible();
});
