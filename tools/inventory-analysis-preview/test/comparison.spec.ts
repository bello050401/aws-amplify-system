import {expect,test} from '@playwright/test';
for(const width of [320,390,1280]) {
  test('paired comparison, changes and capture drilldown at '+width,async({page})=>{
    await page.setViewportSize({width,height:900});
    await page.goto('/?view=breakdown&fixture=comparison');
    await page.getByRole('button',{name:'2週間前',exact:true}).click();
    const pair=page.getByRole('region',{name:'カテゴリー別のSKU数の比較',exact:true});
    await expect(page.locator('.analysis-paired-card')).toHaveCount(2);
    const card=page.locator('.analysis-paired-card').first();
    await expect(card).toContainText('過去');await expect(card).toContainText('現在');await expect(card).toContainText('合計の増減');
    await expect(card).toContainText('+1 SKU');
    const rings=card.locator('.analysis-paired-period');
    const before=await rings.nth(0).boundingBox(),now=await rings.nth(1).boundingBox();
    expect(Math.abs(before!.y-now!.y)).toBeLessThan(2);
    expect(now!.x).toBeGreaterThan(before!.x);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const prior=card.getByRole('button',{name:/過去の.*SKU.*の内訳を開く/}).first();
    await prior.focus();await page.keyboard.press('Enter');
    await expect(page.getByRole('button',{name:'← グラフに戻る',exact:true})).toBeVisible();
    expect(new URL(page.url()).searchParams.get('detailDaily')).toBe('2026-10-31');
    expect(new URL(page.url()).searchParams.get('generation')).toBe('synthetic-inventory-2026-10-31');
    await page.getByRole('button',{name:'← グラフに戻る',exact:true}).click();
    await expect(card).toBeVisible();
    await page.getByRole('button',{name:'3週間前',exact:true}).click();
    await expect(page.getByText('この日の在庫データはありません。')).toBeVisible();
    await expect(page.locator('.analysis-paired-card')).toHaveCount(0);
    await page.getByRole('button',{name:'4週間前',exact:true}).click();
    await expect(page.getByText('集計を取得できませんでした。')).toBeVisible();
    await page.getByRole('button',{name:'現在のみ',exact:true}).click();
    await expect(page.getByRole('button',{name:'現在のみ',exact:true})).toHaveAttribute('aria-pressed','true');
  });
}
