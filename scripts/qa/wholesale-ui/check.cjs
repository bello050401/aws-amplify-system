const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
async function run() {
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const open = async mode => { await page.goto('http://127.0.0.1:43144/?mode=' + mode); await page.getByRole('heading', { name: '業販一覧', exact: true }).waitFor(); };
  const select = async () => { await page.getByRole('button', { name: '一覧の未設定商品を100件まで選択' }).click(); };
  const save = async () => { await page.getByRole('button', { name: '業者間行きにする', exact: true }).click(); await page.getByRole('button', { name: /この\d+件を保存/ }).click(); };
  await open('normal'); await select();
  assert.equal(await page.locator('tbody input[type="checkbox"]').evaluateAll(nodes => nodes.filter(node => node.checked).length), 5);
  await page.getByRole('button', { name: '仕入額 / 点' }).click();
  assert.equal(await page.locator('tbody input[type="checkbox"]').evaluateAll(nodes => nodes.filter(node => node.checked).length), 5, 'sorting preserves selection');
  const prices = await page.locator('tbody tr td:nth-child(3)').allTextContents();
  assert.equal(prices[0], '¥10,000'); assert.equal(prices.at(-1), '—');
  await page.screenshot({ path: 'artifacts/wholesale-ui/desktop.png', fullPage: true });
  await save(); await page.getByRole('status').filter({ hasText: '保存済み 5件' }).waitFor();
  assert.equal(await page.locator('tbody input[type="checkbox"]').evaluateAll(nodes => nodes.filter(node => node.checked).length), 0);
  await open('partial'); await select(); await save(); await page.getByRole('status').filter({ hasText: '失敗 1件' }).waitFor();
  assert.equal(await page.locator('tbody input[type="checkbox"]').evaluateAll(nodes => nodes.filter(node => node.checked).length), 1, 'failed selection retained');
  await open('network'); await select(); await save(); await page.getByRole('button', { name: '同じ受付内容で結果を確認' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '業者間行きにする', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '同じ受付内容で結果を確認' }).click();
  await page.getByRole('status').filter({ hasText: '保存済み 5件' }).waitFor();
  const requests = await page.evaluate(() => window.wholesaleFixtureCalls);
  assert.deepEqual(requests[0], requests[1], 'unknown outcome uses identical mutation and payload');
  await open('unknown'); await select(); await save(); await page.getByRole('status').filter({ hasText: '結果不明 5件' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '再読込', exact: true }).isDisabled(), true);
  await open('viewer'); assert.equal(await page.locator('tbody input[type="checkbox"]').first().isDisabled(), true); assert.equal(await page.getByRole('button', { name: '業者間行きにする', exact: true }).isDisabled(), true);
  await open('limit'); await select(); assert.equal(await page.locator('tbody input[type="checkbox"]').evaluateAll(nodes => nodes.filter(node => node.checked).length), 100);
  await save(); await page.getByRole('status').filter({ hasText: '保存済み 100件' }).waitFor();
  assert.equal(await page.evaluate(() => window.wholesaleFixtureCalls[0].items.length), 100);
  await open('load-error'); await page.getByRole('status').filter({ hasText: '一覧を取得できませんでした' }).waitFor(); assert.equal(await page.locator('table').count(), 0);
  await open('normal'); await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'narrow viewport has no page overflow');
  await page.screenshot({ path: 'artifacts/wholesale-ui/narrow.png', fullPage: true });
  console.log('PASS wholesale web: sorting, selection, save, partial failure, unknown retry, viewer, max100, load error, narrow viewport');
 } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
