import {expect,test} from '@playwright/test';

test('native components preserve analysis state after opening a product',async ({page},testInfo)=>{
  const origin = process.env.BELLO_NATIVE_PREVIEW_URL;
  test.skip(!origin,'Provide the Expo Metro fixture origin');
  const out = new URL(origin!);
  const external:string[]=[];
  const applicationRequests:string[]=[];
  await page.setViewportSize({width:390,height:820});
  await page.route('**/*',async route=>{
    const request = new URL(route.request().url());
    if (request.origin!==out.origin) {
      if(request.protocol!=='data:') external.push(request.href);
      return route.abort();
    }
    if(request.pathname.startsWith('/api/')) {applicationRequests.push(request.pathname);return route.abort();}
    if(request.pathname !== '/' || route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(/<script src="[^"]+\.bundle\?[^"]+" defer><\/script>/,
      '<script src="/analysis-preview.bundle?platform=web&dev=true&hot=false&lazy=false" defer></script>');
    expect(html).toContain('analysis-preview.bundle');
    return route.fulfill({response,body:html});
  });
  await page.goto(out.href);
  const bottomSales = page.getByRole('tab',{name:'売上',exact:true});
  await bottomSales.click();
  await expect(page.getByText('¥332,000',{exact:true}).first()).toBeVisible();
  await expect(page.getByRole('button',{name:/ベンチ・オットマン.*¥100,000/})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'直近30日',exact:true})).toHaveCount(0);
  await expect(page.getByText('¥888,000',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('tab',{name:'在庫金額',exact:true})).toBeVisible();
  await expect(page.getByRole('tab',{name:'SKU内訳',exact:true})).toBeVisible();
  await expect(page.getByText('直近12ヶ月の推移',{exact:true})).toBeVisible();
  await expect(page.locator('path[stroke="#111827"]')).toHaveCount(1);
  const currentMonth = page.getByRole('button',{name:'2026年11月を選択',exact:true});
  await expect(currentMonth).toBeVisible();
  await page.getByRole('button',{name:'前月',exact:true}).click();
  await expect(page.getByRole('button',{name:'2026年10月を選択',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'売却管理',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'請求書発行',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'売却管理',exact:true}).click();
  await expect(page.getByRole('heading',{name:'売却管理（操作確認用）'})).toBeVisible();
  await page.getByRole('button',{name:'戻る',exact:true}).click();
  await page.getByRole('button',{name:'請求書発行',exact:true}).click();
  await expect(page.getByRole('heading',{name:'請求書発行（操作確認用）'})).toBeVisible();
  await page.getByRole('button',{name:'戻る',exact:true}).click();
  await page.getByRole('tab',{name:'SKU内訳',exact:true}).click();
  await page.getByRole('button',{name:/8点保有.*1 SKU/}).click();
  await expect(page.getByText('管理SKU SKU-BENCH',{exact:true})).toBeVisible();
  await expect(page.getByText(/¥80,000|8点 ·/)).toHaveCount(0);
  await page.getByRole('button',{name:'構成レコードを表示（2件）'}).click();
  await page.getByRole('button',{name:'商品詳細',exact:true}).first().click();
  await expect(page.getByRole('button',{name:'戻る',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'戻る',exact:true}).click();
  await expect(page.getByRole('tab',{name:'SKU内訳',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByText('8点保有の内訳',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'← グラフに戻る'}).click();
  await expect(page.getByRole('button',{name:/8点保有.*1 SKU/})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('native-390.png')});
  const purchase = page.getByRole('button',{name:'直近30日の仕入れ',exact:true});
  const lots = page.getByRole('button',{name:'仕入ロット数',exact:true});
  await expect(lots).toHaveCount(0);
  await purchase.click();
  await expect(lots).toBeVisible();
  await expect(page.getByText('現在庫のSKU',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'在庫金額',exact:true}).click();
  await expect(page.getByText('作業状況別の在庫金額',{exact:true})).toHaveCount(1);
  await expect(page.getByText('作業状況別の在庫数量',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'作業状況別の数量を見る',exact:true}).click();
  await expect(page.getByText('作業状況別の在庫数量',{exact:true})).toBeVisible();
  expect(external).toEqual([]);
  expect(applicationRequests).toEqual([]);
});


