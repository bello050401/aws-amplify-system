import {expect,test,type Page,type TestInfo} from '@playwright/test';

async function screenshot(page:Page,testInfo:TestInfo,name:string) {
  await page.screenshot({path:testInfo.outputPath(name+'.png'),animations:'disabled',fullPage:true});
}
async function isolated(page:Page,baseURL:string) {
  const external:string[] = [];
  const origin = new URL(baseURL).origin;
  await page.route('**/*',route=>{
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  return external;
}

for (const width of [320,390,768,1280]) {
  test('three tabs and preserved selections at '+width,async ({page,baseURL},testInfo)=>{
    const external = await isolated(page,baseURL!);
    await page.setViewportSize({width,height:820});
    await page.goto('/?salesAnalysis=1');
    const tabs = page.getByRole('navigation',{name:'売上・在庫の切り替え'});
    await expect(tabs.getByRole('link')).toHaveText(['売上','在庫金額','在庫内訳']);
    for (const name of ['売上','在庫金額','在庫内訳']) {
      const tab = tabs.getByRole('link',{name,exact:true});
      const bounds = await tab.boundingBox();
      expect(bounds).toBeTruthy();
      expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole('region',{name:'選択期間の売上'})).toContainText('¥332,000');
    await expect(page.getByText('（途中）')).toBeVisible();
    await page.getByRole('button',{name:'直近30日',exact:true}).click();
    await expect(page.getByRole('region',{name:'選択期間の売上'})).toContainText('¥346,000');
    const salesChart = page.getByRole('region',{name:'カテゴリー別の売上',exact:true});
    await expect(salesChart.getByRole('button',{name:/未分類.*¥12,000/})).toBeVisible();
    await salesChart.getByRole('button',{name:'すべて見る',exact:true}).click();
    await expect(salesChart.getByRole('button',{name:/インテリア・アート.*¥14,000/})).toBeVisible();
    await page.getByRole('button',{name:'数量帯を詳しく',exact:true}).click();
    await expect(page.getByRole('button',{name:/4〜8点.*¥100,000/})).toBeVisible();
    if(width===390||width===1280) await screenshot(page,testInfo,'sales-'+width);

    const legend = salesChart.getByRole('button',{name:/ベンチ・オットマン.*¥100,000/});
    await legend.focus();
    await page.keyboard.press('Enter');
    const detail = page.getByRole('region',{name:'ベンチ・オットマンの内訳',exact:true});
    await expect(detail.getByRole('heading',{name:/オーク無垢材/})).toBeVisible();
    const first = new URL(page.url());
    expect(first.searchParams.get('generation')).toBe('synthetic-2026-11-14');
    await detail.getByRole('button',{name:'← グラフに戻る'}).click();
    const arc = salesChart.getByRole('button',{name:'ベンチ・オットマンの円グラフから内訳を開く'});
    if(width===320) {
      const point = await arc.evaluate(element=>{
        const path = element as SVGPathElement;
        const middle = path.getPointAtLength(path.getTotalLength()/2);
        const location = new DOMPoint(middle.x,middle.y).matrixTransform(path.getScreenCTM()!);
        return {x:location.x,y:location.y};
      });
      await page.mouse.click(point.x,point.y);
    } else {
      await arc.focus();
      await page.keyboard.press('Space');
    }
    await expect(detail).toBeVisible();
    expect(new URL(page.url()).searchParams.get('slice')).toBe(first.searchParams.get('slice'));
    await page.reload();
    await expect(detail.getByRole('heading',{name:/オーク無垢材/})).toBeVisible();
    await detail.getByRole('button',{name:'← グラフに戻る'}).click();

    await tabs.getByRole('link',{name:'在庫金額',exact:true}).click();
    await expect(page.getByRole('region',{name:'作業状況別の在庫金額',exact:true})).toHaveCount(1);
    await expect(page.getByRole('region',{name:'作業状況別の在庫数量',exact:true})).toHaveCount(1);
    const holding = page.getByRole('region',{name:'在庫数別の内訳',exact:true});
    await expect(holding.getByRole('button',{name:/8点保有.*¥80,000.*80\.0%/})).toBeVisible();
    if(width===390) await screenshot(page,testInfo,'inventory-value-'+width);
    await holding.getByRole('button',{name:/8点保有.*¥80,000/}).click();
    const group = page.getByRole('region',{name:'8点保有の内訳',exact:true});
    await group.getByRole('button',{name:'構成レコードを表示（2件）'}).click();
    await expect(group.getByText('画像なし',{exact:true})).toBeVisible();
    await expect(group.locator('img').first()).toHaveJSProperty('complete',true);
    if(width===390) await screenshot(page,testInfo,'expanded-detail-'+width);

    await tabs.getByRole('link',{name:'在庫内訳',exact:true}).click();
    await expect(page.getByRole('region',{name:'在庫数別の内訳',exact:true}).getByRole('button',{name:/8点保有.*8点.*88\.9%/})).toBeVisible();
    await page.getByRole('button',{name:'確認済みの商品種類数',exact:true}).click();
    await expect(page.getByRole('region',{name:'在庫数別の内訳',exact:true}).getByRole('button',{name:/8点保有.*1種類.*50\.0%/})).toBeVisible();
    await page.getByRole('button',{name:'直近30日の仕入れ',exact:true}).click();
    const acquisitions = page.getByRole('region',{name:'直近30日の仕入れ',exact:true});
    await expect(acquisitions).toContainText('¥270,000');
    await expect(acquisitions).toContainText('確認できた仕入数量23点');
    await expect(acquisitions).toContainText('仕入ロット数3ロット');
    await page.getByRole('button',{name:'小売実績の参考配分と比較',exact:true}).click();
    await expect(page.getByRole('region',{name:'直近90日の小売実績',exact:true})).toContainText('¥100,000');
    await page.getByRole('button',{name:'仕入ロット数',exact:true}).click();
    await expect(page.getByRole('region',{name:'カテゴリー別の仕入ロット数',exact:true})).toBeVisible();
    if(width===390) await screenshot(page,testInfo,'inventory-breakdown-'+width);

    await tabs.getByRole('link',{name:'売上',exact:true}).click();
    await expect(page.getByRole('button',{name:'直近30日',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(page.getByRole('button',{name:'単品・複数に戻す',exact:true})).toHaveAttribute('aria-pressed','true');
    await tabs.getByRole('link',{name:'在庫内訳',exact:true}).click();
    await expect(page.getByRole('button',{name:'仕入ロット数',exact:true})).toHaveAttribute('aria-pressed','true');
    await page.getByRole('button',{name:'現在庫',exact:true}).click();
    await expect(page.getByRole('button',{name:'確認済みの商品種類数',exact:true})).toHaveAttribute('aria-pressed','true');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(external).toEqual([]);
  });
}

test('missing, empty, retry, unknown cost and negative net',async ({page,baseURL},testInfo)=>{
  const external = await isolated(page,baseURL!);
  await page.setViewportSize({width:390,height:820});
  await page.goto('/?fixture=empty&salesAnalysis=1');
  await expect(page.getByText('対象データなし',{exact:true})).toHaveCount(2);
  await expect(page.getByRole('region',{name:'選択期間の売上'})).toContainText('¥0');
  await page.goto('/?fixture=missing&salesAnalysis=1');
  await expect(page.getByText('集計データなし',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'選択期間の売上'})).toHaveCount(0);
  await page.goto('/?fixture=error&salesAnalysis=1');
  await expect(page.getByText('集計を取得できませんでした。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'集計を再試行'}).click();
  await expect(page.getByRole('region',{name:'選択期間の売上'})).toContainText('¥332,000');
  await page.goto('/?fixture=unknown&view=inventory');
  await expect(page.getByText('原価未登録のため金額割合を表示できません。',{exact:true})).toHaveCount(2);
  await expect(page.getByText('在庫数量 1点',{exact:true})).toBeVisible();
  await page.goto('/?fixture=negative&salesAnalysis=1');
  await expect(page.getByRole('region',{name:'選択期間の売上'})).toContainText('差引 −¥118,000');
  await expect(page.getByRole('region',{name:'カテゴリー別の売上',exact:true})).toContainText('売上（返品前）¥332,000');
  await screenshot(page,testInfo,'returns-390');
  expect(external).toEqual([]);
});

test('month, previous month and explicit sales ranges',async ({page})=>{
  await page.goto('/?salesAnalysis=1');
  await page.getByRole('button',{name:'前月',exact:true}).click();
  await expect(page.getByRole('region',{name:'選択期間の売上'})).toContainText('¥14,000');
  await page.getByRole('button',{name:'月指定',exact:true}).click();
  await expect(page.getByLabel('対象月').locator('option').last()).toHaveText('2026年01月');
  await page.getByLabel('対象月').selectOption('2026-01');
  await expect(page.getByText('集計データなし',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'期間指定',exact:true}).click();
  await page.getByLabel('開始日').fill('2026-11-07');
  await page.getByLabel('終了日').fill('2026-11-07');
  await page.getByRole('button',{name:'期間を適用'}).click();
  await expect(page.getByRole('region',{name:'選択期間の売上'})).toContainText('¥332,000');
});




test('the pure production aggregate renders the same legacy totals and its own drilldown',async ({page,baseURL})=>{
  const external = await isolated(page,baseURL!);
  await page.setViewportSize({width:390,height:820});
  await page.goto('/?fixture=core&salesAnalysis=1');
  const sales = page.getByRole('region',{name:'選択期間の売上'});
  await expect(sales).toContainText('差引 ¥115,000');
  await expect(sales).toContainText('売上（返品前）¥125,000');
  const tabs = page.getByRole('navigation',{name:'売上・在庫の切り替え'});
  await tabs.getByRole('link',{name:'在庫金額',exact:true}).click();
  await expect(page.getByText('在庫数量 9点',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'¥100,000',exact:true})).toBeVisible();
  const holding = page.getByRole('region',{name:'在庫数別の内訳',exact:true});
  await holding.getByRole('button',{name:/8点保有.*¥80,000.*80\.0%/}).click();
  await page.getByRole('button',{name:'構成レコードを表示（2件）'}).click();
  await expect(page.getByRole('heading',{name:'サンプル家具 M1 ダイニングチェア',exact:true}).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get('generation')).toBe('fixture-analysis-20261114');
  await tabs.getByRole('link',{name:'在庫内訳',exact:true}).click();
  await page.getByRole('button',{name:'直近30日の仕入れ',exact:true}).click();
  const acquisitions = page.getByRole('region',{name:'直近30日の仕入れ',exact:true});
  await expect(acquisitions).toContainText('¥150,000');
  await expect(acquisitions).toContainText('確認できた仕入数量15点');
  await expect(acquisitions).toContainText('仕入ロット数1ロット');
  await page.getByRole('button',{name:'小売実績の参考配分と比較',exact:true}).click();
  await expect(page.getByRole('region',{name:'直近90日の小売実績',exact:true})).toContainText('¥70,000');
  expect(external).toEqual([]);
});

test('sale prices and unknown acquisition costs have independent coverage',async ({page})=>{
  const sales = page.getByRole('region',{name:'選択期間の売上',exact:true});
  const chart = page.getByRole('region',{name:'カテゴリー別の売上',exact:true});
  await page.goto('/?fixture=known-sale&salesAnalysis=1');
  await expect(sales).toContainText('¥100,000');
  await expect(sales).toContainText('原価未登録 1件');
  await expect(chart.getByRole('button',{name:/ベンチ・オットマン.*¥100,000.*100\.0%/})).toBeVisible();

  await page.goto('/?fixture=zero-sale&salesAnalysis=1');
  await expect(sales).toContainText('¥0');
  await expect(chart.getByRole('button',{name:/ベンチ・オットマン.*¥0/})).toBeVisible();
  await expect(page.getByText('売上金額未登録のため金額割合を表示できません。')).toHaveCount(0);

  await page.goto('/?fixture=unknown-sale&salesAnalysis=1');
  await expect(sales).toContainText('売上金額未登録 1件');
  await expect(chart).not.toContainText('¥0');
  await expect(chart.getByText('売上金額未登録のため金額割合を表示できません。')).toBeVisible();
});

test('sales charts request the generation displayed by the legacy monthly totals',async ({page})=>{
  const sales = page.getByRole('region',{name:'選択期間の売上',exact:true});
  await page.goto('/?fixture=generation-race&salesAnalysis=1');
  await expect(sales).toContainText('¥332,000');
  await expect(sales).not.toContainText('¥888,000');
  await page.getByRole('button',{name:'直近30日',exact:true}).click();
  await expect(sales).toContainText('¥346,000');

  await page.goto('/?fixture=wrong-generation&salesAnalysis=1');
  await expect(page.getByText('この集計版は参照期限を過ぎました。')).toBeVisible();
  await expect(sales).toHaveCount(0);
});

test('acquisition donuts share the pre-return denominator with their centers',async ({page})=>{
  await page.goto('/?fixture=core-return&view=breakdown&breakdown=acquisitions');
  const acquisitions = page.getByRole('region',{name:'直近30日の仕入れ',exact:true});
  const amounts = page.getByRole('region',{name:'カテゴリー別の仕入原価',exact:true});
  await expect(acquisitions).toContainText('返品・取消 ¥80,000 · 差引 −¥30,000');
  await expect(amounts).toContainText('仕入原価（返品前）¥50,000');
  await expect(amounts.getByRole('button',{name:/ダイニングチェア.*¥50,000.*100\.0%/})).toBeVisible();
  await page.getByRole('button',{name:'仕入数量',exact:true}).click();
  const counts = page.getByRole('region',{name:'カテゴリー別の仕入数量',exact:true});
  await expect(acquisitions).toContainText('返品・取消 8点 · 差引 -3点');
  await expect(counts).toContainText('仕入数量（返品前）5点');
  await expect(counts.getByRole('button',{name:/ダイニングチェア.*5点.*100\.0%/})).toBeVisible();
  await expect(counts.getByRole('button',{name:'テーブル・デスクの円グラフから内訳を開く'})).toHaveCount(0);
});

test('monthly sales opens with the original trend and without analysis controls',async ({page})=>{
  await page.goto('/');
  await expect(page.getByRole('group',{name:'売上期間'})).toHaveCount(0);
  const chart = page.getByRole('img',{name:'直近12ヶ月の売上高・粗利益推移'});
  await expect(chart).toBeVisible();
  await expect(chart.locator('path[stroke="#111827"]')).toHaveCount(1);
  await expect(chart.locator('path[stroke="#10b981"]')).toHaveCount(1);
  await expect(chart.locator('circle[stroke="#dc2626"]')).toHaveCount(1);
  await expect(chart.locator('circle[stroke="#9ca3af"]')).toHaveCount(1);
});

for (const width of [320,390,1280]) {
  test('inventory shows exact numeric counts in a responsive legend at '+width,async ({page},testInfo)=>{
    await page.setViewportSize({width,height:820});
    await page.goto('/?fixture=exact-counts&view=breakdown');
    const category = page.getByRole('region',{name:'カテゴリー別の在庫数量'});
    const donut = category.locator('svg');
    const legend = category.locator('.analysis-legend-list');
    await expect(donut).toBeVisible();
    await expect(legend).toBeVisible();
    const donutBounds = (await donut.boundingBox())!;
    const legendBounds = (await legend.boundingBox())!;
    if (width >= 680) expect(legendBounds.x).toBeGreaterThan(donutBounds.x + donutBounds.width);
    else expect(legendBounds.y).toBeGreaterThan(donutBounds.y + donutBounds.height);

    const holding = page.getByRole('region',{name:'在庫数別の内訳'});
    await expect(holding).toContainText('同一商品として確認済みのものは合算、未照合は商品ページごとに集計。');
    await expect(holding).toContainText('割合の分母は、集計時点の在庫数量の合計です。');
    await expect(holding.locator('.analysis-legend-label > span')).toHaveText(['1点保有','2点保有','3点保有','5点保有','8点保有']);
    await expect(holding.getByText(/2〜3点|4〜8点|2点以上/)).toHaveCount(0);
    await expect(holding.getByRole('button',{name:/2点保有.*1商品ページ.*2点.*10\.5%/})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width!==320) await screenshot(page,testInfo,'exact-holdings-'+width);
    await holding.getByRole('button',{name:/2点保有.*10\.5%/}).click();
    const detail = page.getByRole('region',{name:'2点保有の内訳'});
    await expect(detail.getByRole('heading',{name:'在庫数が2点の商品'})).toBeVisible();
    await expect(detail.getByText('未照合・商品ページの在庫数')).toBeVisible();
    await page.reload();
    await expect(detail.getByRole('heading',{name:'在庫数が2点の商品'})).toBeVisible();
  });
}

for (const width of [320,390,1280]) {
  test('dense current inventory keeps every category and exact count visible at '+width,async ({page},testInfo)=>{
    await page.setViewportSize({width,height:820});
    await page.goto('/?fixture=dense-stock&view=breakdown');
    const category = page.getByRole('region',{name:'カテゴリー別の在庫数量'});
    const holding = page.getByRole('region',{name:'在庫数別の内訳'});
    await expect(category.locator('.analysis-legend')).toHaveCount(13);
    await expect(holding.locator('.analysis-legend')).toHaveCount(16);
    await expect(holding.getByRole('button',{name:/2点保有.*31商品ページ.*62点/})).toBeVisible();
    await expect(holding.getByRole('button',{name:/94点保有.*1商品ページ.*94点/})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await holding.locator('path').evaluateAll(paths=>new Set(paths.map(path=>path.getAttribute('stroke'))).size)).toBeGreaterThan(12);
    await screenshot(page,testInfo,'dense-inventory-'+width);
    await page.getByRole('button',{name:'確認済みの商品種類数',exact:true}).click();
    await expect(holding.getByText('31商品ページ',{exact:true})).toHaveCount(0);
  });
}
