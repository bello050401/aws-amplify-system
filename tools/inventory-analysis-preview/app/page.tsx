'use client';

import {Suspense,useMemo} from 'react';
import {SalesTrendDisclosure} from '../../../app/inventory/(protected)/sales/SalesTrendChart';
import {useSearchParams} from 'next/navigation';
import {InventoryValuePicker,InventoryValueReport} from '../../../app/inventory/(protected)/sales/InventoryValuePanel';
import {SalesAnalysis,SalesAnalysisTabs} from '../../../app/inventory/(protected)/sales/analysis/SalesAnalysis';
import {createCoreFixture} from './coreFixture';
import {createFixtures,generation,previewToday} from '../../../lib/inventory/analysisUi/fixtures';

function Preview() {
  const query = useSearchParams();
  const mode = query.get('fixture');
  const fixture = useMemo(()=>mode==='core' || mode==='core-return' ? createCoreFixture(mode==='core-return') : createFixtures(mode),[mode]);
  const pinned = mode==='generation-race' || mode==='wrong-generation' ? generation : undefined;
  const isValue = query.get('view') === 'inventory';
  const month = query.get('month') ?? undefined;
  return <main className="preview-main">
    <SalesAnalysisTabs today={previewToday}/>
    {isValue && <div className="mb-5"><InventoryValuePicker key={month} action="/" month={month} query={Object.fromEntries(query)}/></div>}
    <SalesAnalysis today={previewToday} salesGeneration={pinned} ports={fixture.ports} inventoryFallback={isValue ? <InventoryValueReport view={{status:'missing'}}/> : undefined}/>
    {!query.get('view') && <SalesTrendDisclosure points={previewTrend}/>}
  </main>;
}

export default function PreviewPage() {
  return <Suspense fallback={<main className="preview-main">検証画面を読み込み中…</main>}><Preview/></Suspense>;
}

const previewTrend = [
  {year:2026,month:8,status:'missing' as const,totalSales:0,totalGrossProfit:0},
  {year:2026,month:9,status:'error' as const,totalSales:0,totalGrossProfit:0},
  {year:2026,month:10,status:'ok' as const,totalSales:0,totalGrossProfit:0},
  {year:2026,month:11,status:'ok' as const,totalSales:332_000,totalGrossProfit:-40_000},
];
