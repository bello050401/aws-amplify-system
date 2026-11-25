'use client';

import Link from 'next/link';
import {usePathname,useSearchParams} from 'next/navigation';
import {useRef,useState,type FormEvent,type ReactNode} from 'react';
import {formatJstDateTime} from '../../../../../lib/inventory/sales';
import {
  analysisRequest,inventoryComparisonRequest,chartBasis,chartContent,detailMetricFor,firstMonth,formatMetric,groupingFor,inventoryCompositionNote,skuHoldingNote,jstDay,metricFor,metricLabel,monthChoices,
  PERIODS,stateFromQuery,summaryRequest,TABS,unknownAmount,writeQuery,type AnalysisPorts,type AnalysisResult,type AnalysisState,
  type DisplayRow,type Metric,type Slice,type Dimension,
} from '../../../../../lib/inventory/analysisUi/model';
import {comparisonBuckets} from '../../../../../lib/inventory/analysisUi/comparison';
import {useAnalysis} from '../../../../../lib/inventory/analysisUi/useAnalysis';
import {AnalysisDetail} from './AnalysisDetail';
import {AnalysisDonut} from './AnalysisDonut';
import {AnalysisComparison} from './AnalysisComparison';
import {AnalysisManagement} from './AnalysisManagement';
import type {AnalysisManagementPorts} from '../../../../../lib/inventory/analysisUi/management';
import {InventoryValueReport} from '../InventoryValuePanel';

export function SalesAnalysisTabs({today=jstDay()}:{today?:string}) {
  const pathname = usePathname();
  const query = useSearchParams();
  const state = stateFromQuery(new URLSearchParams(query),today);
  return <nav aria-label="売上・在庫の切り替え" className="analysis-tabs">
    {TABS.map(tab=>{
      const next = writeQuery(new URLSearchParams(query),{...state,tab:tab.key,slice:state.tab === tab.key ? state.slice : null});
      return <Link key={tab.key} prefetch={false} aria-current={state.tab === tab.key?'page':undefined}
        href={pathname+'?'+next}>{tab.label}</Link>;
    })}
  </nav>;
}

export function SalesAnalysis({ports,today=jstDay(),productLinks=false,management,inventoryFallback,salesGeneration}:{
  ports?:AnalysisPorts; today?:string; productLinks?:boolean; management?:AnalysisManagementPorts; inventoryFallback?:ReactNode; salesGeneration?:string|null;
}) {
  const query = useSearchParams();
  const pathname = usePathname();
  const state = stateFromQuery(new URLSearchParams(query),today);
  const skuTab = state.tab === 'breakdown';
  const request = analysisRequest(skuTab ? {...state,breakdown:'inventory'} : state,today);
  const metric = skuTab ? 'skus' : metricFor(state);
  const {key,detailed} = groupingFor(state);
  const pinned = summaryRequest(request,salesGeneration);
  const read = useAnalysis(ports?.load,state.slice ? null : pinned);
  const data = request && !pinned ? {status:'missing' as const} : read.data;
  const retry = read.retry;
  const acquisition = state.tab === 'breakdown' && state.breakdown === 'acquisitions';
  const acquisitionRequest = {target:'acquisitions'} as const;
  const purchase = useAnalysis(ports?.load,acquisition && !state.slice ? acquisitionRequest : null);
  const purchaseGeneration = purchase.data?.status === 'ok' ? purchase.data.metadata.generation : null;
  const compare = acquisition && state.acquisitionUnit === 'amount' && !!purchaseGeneration;
  const reference = useAnalysis(ports?.load,state.reference && compare && purchaseGeneration ? {target:'retailReference',generation:purchaseGeneration} : null);
  const comparing = request?.target === 'inventory' && (state.inventoryCompareWeeks > 0 || Boolean(state.inventoryCompareDay));
  const anchor = data;
  const weeksRequest = inventoryComparisonRequest(anchor?.status==='ok' ? anchor.metadata.asOf : today+'T00:00:00+09:00',state.inventoryCompareWeeks || 2);
  const historicalRequest = state.inventoryCompareDay ? {target:'inventory' as const,daily:state.inventoryCompareDay} : weeksRequest;
  const comparisonDay = historicalRequest.daily!;
  const availableDays = anchor?.status==='ok' ? (anchor.metadata.inventoryHistoryAvailableDays??[]).filter(day=>day < anchor.metadata.coverageEnd).sort().reverse() : [];
  const historical = useAnalysis(ports?.load,comparing && anchor?.status==='ok' && !state.slice ? historicalRequest : null);
  const source = useRef<HTMLElement | SVGElement | null>(null);
  const content = useRef<HTMLDivElement>(null);

  function update(change:Partial<AnalysisState>, enterDetail=false) {
    const selection = {...state,slice:null,...change};
    const next = writeQuery(new URLSearchParams(query),selection);
    const href = pathname + '?' + next.toString();
    if (enterDetail) window.history.pushState(null,'',href);
    else window.history.replaceState(null,'',href);
  }
  function select(slice:Slice) {
    const active = document.activeElement;
    if (active instanceof HTMLElement || active instanceof SVGElement) source.current = active;
    update({slice},true);
  }
  function close() {
    update({slice:null});
    window.requestAnimationFrame(()=>{
      if (source.current?.isConnected) source.current.focus();
      else content.current?.querySelector<HTMLElement>('button,select,input')?.focus();
    });
  }
  function productHref(id:string) {
    return '/inventory/'+encodeURIComponent(id)+'?salesFrom='+encodeURIComponent(query.toString());
  }

  const currentGraphs = request && <AnalysisResultView data={data} retry={retry} metric={metric} detailed={detailed}
    toggleBands={()=>update({detailed:{...state.detailed,[key]:!detailed}})} select={select} request={request}
    showSummaryTotal={state.tab !== 'inventory'}/>;
  const graphs = <>
    {request?.target === 'inventory' && <div className="analysis-comparison-controls">
      <Choices label="在庫の比較期間" value={state.inventoryCompareDay ? 'date' : String(state.inventoryCompareWeeks)}
        options={[{key:'0',label:'現在のみ'},{key:'2',label:'2週間前'},{key:'3',label:'3週間前'},{key:'4',label:'4週間前'}] as const}
        select={weeks=>update({inventoryCompareWeeks:Number(weeks) as 0|2|3|4,inventoryCompareDay:''})}/>
      {availableDays.length>0 && <label className="analysis-field">記録のある日から選ぶ<select aria-label="記録のある比較日" value={state.inventoryCompareDay??''} onChange={event=>update({inventoryCompareDay:event.target.value,inventoryCompareWeeks:0})}><option value="">日付を選択</option>{availableDays.map(day=><option key={day} value={day}>{day.replaceAll('-','/')}</option>)}</select></label>}
    </div>}
    {comparing && data?.status==='ok' && historical.data?.status==='ok' && (metric!=='skus' || historical.data.summary.skus!==undefined && data.summary.skus!==undefined) ? <AnalysisComparison current={data} prior={historical.data} currentRequest={request!} priorRequest={historicalRequest} metric={metric} detailed={detailed} select={select}/> : comparing ? <>
      <section className="analysis-card" role="status" aria-label="過去の在庫の比較状況">
        <h2 className="analysis-comparison-heading">{state.inventoryCompareDay ? '指定日' : state.inventoryCompareWeeks+'週間前'} · {comparisonDay.replaceAll('-','/')}</h2>
        <p>{anchor?.status!=='ok' ? '基準の在庫データを取得すると比較できます。' : !historical.data ? '過去の在庫を読み込み中…' : historical.data.status==='ok' ? 'この時点のSKU内訳の記録はありません。' : historical.data.status==='missing' ? 'この日の在庫データはありません。記録のある日を選んでください。' : historical.data.status==='expired' ? 'この集計版は参照期限を過ぎました。' : '集計を取得できませんでした。'}</p>
        {historical.data && ['error','expired'].includes(historical.data.status) && <button type="button" className="analysis-button" onClick={historical.retry}>集計を再試行</button>}
      </section>
      {currentGraphs}
    </> : currentGraphs}
  </>;
  return <div ref={content} className="analysis-content">
    <div hidden={Boolean(state.slice && ports)}>
      {state.tab==='sales' && <>
        <Choices label="売上期間" options={PERIODS} value={state.preset} select={preset=>update({preset})}/>
        {state.preset === 'month' && <label className="analysis-field">対象月
          <select value={state.saleMonth} onChange={event=>update({saleMonth:event.target.value})}>
            {monthChoices(today).map(month=><option key={month} value={month}>{month.replace('-','年')}月</option>)}
          </select>
        </label>}
        {state.preset === 'custom' && <CustomDateRange key={state.start+':'+state.end} today={today}
          start={state.start} end={state.end} apply={(start,end)=>update({start,end})}/>}
      </>}
      {!request ? <p className="analysis-note" role="status">2026年1月1日以降で有効な開始日と終了日を指定してください。</p>
        : state.tab==='inventory'
          ? data?.status==='ok'
            ? <InventoryValueReport view={{status:'ok',value:{...data.inventoryValue,month:state.inventoryMonth || undefined}}} analysis={graphs}/>
            : <>{inventoryFallback}{graphs}</>
          : graphs}
      {skuTab && <section className="analysis-secondary">
        <button type="button" className="analysis-button" aria-expanded={acquisition} onClick={()=>update({breakdown:acquisition ? 'inventory' : 'acquisitions'})}>直近30日の仕入れ</button>
        {acquisition && <>
          <Choices label="仕入れの集計単位" options={[{key:'amount',label:'仕入原価'},{key:'quantity',label:'仕入数量'},{key:'lots',label:'仕入ロット数'}] as const} value={state.acquisitionUnit} select={acquisitionUnit=>update({acquisitionUnit})}/>
          <AnalysisResultView data={purchase.data} retry={purchase.retry} metric={state.acquisitionUnit} detailed={detailed}
            toggleBands={()=>update({detailed:{...state.detailed,acquisitions:!detailed}})} select={select} request={acquisitionRequest}/>
          {compare && <>
            <button type="button" className="analysis-button" aria-expanded={state.reference} onClick={()=>update({reference:!state.reference})}>小売実績の参考配分と比較</button>
            {state.reference && <AnalysisResultView data={reference.data} retry={reference.retry} metric="amount" detailed={false} select={select} request={{target:'retailReference'}}/>}
          </>}
        </>}
      </section>}
      {management && <AnalysisManagement ports={management}/>}
    </div>
    {state.slice && ports && <AnalysisDetail key={[state.slice.request.generation,state.slice.dimension,state.slice.key].join(':')}
      slice={state.slice} drill={ports.drill}
      onClose={close} metric={detailMetricFor(state.slice,state)} productHref={productLinks ? productHref : undefined} management={management}/>}
  </div>;
}

function CustomDateRange({start,end,today,apply}:{start:string;end:string;today:string;apply:(start:string,end:string)=>void}) {
  const [startDay,setStart] = useState(start);
  const [endDay,setEnd] = useState(end);
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    apply(startDay,endDay);
  }
  return <form className="analysis-dates" onSubmit={submit}>
    <label className="analysis-field">開始日<input required type="date" min={firstMonth+'-01'} max={today} value={startDay} onChange={event=>setStart(event.target.value)}/></label>
    <label className="analysis-field">終了日<input required type="date" min={firstMonth+'-01'} max={today} value={endDay} onChange={event=>setEnd(event.target.value)}/></label>
    <button type="submit" className="analysis-button">期間を適用</button>
  </form>;
}

function Choices<K extends string>({label,options,value,select}:{
  label:string; options:readonly {key:K;label:string}[]; value:K; select:(key:K)=>void;
}) {
  return <div className="analysis-choices" role="group" aria-label={label}>
    {options.map(option=><button type="button" className="analysis-choice" key={option.key}
      aria-pressed={option.key===value} onClick={()=>select(option.key)}>{option.label}</button>)}
  </div>;
}

export function AnalysisResultView({data,retry,request,metric,detailed,toggleBands,select,showSummaryTotal=true,historical=false,comparison=false,onlyDimension,showSkuNotes=true,counterpart}:{
  data:AnalysisResult|null; retry:()=>void; request:NonNullable<ReturnType<typeof analysisRequest>>;
  metric:Metric; detailed:boolean; toggleBands?:()=>void; select:(slice:Slice)=>void; showSummaryTotal?:boolean; historical?:boolean; comparison?:boolean; onlyDimension?:Dimension; showSkuNotes?:boolean; counterpart?:AnalysisResult|null;
}) {
  if (!data) return <p className="analysis-note" role="status">集計を読み込み中…</p>;
  if (data.status !== 'ok') return <div className="analysis-card" role="status">
    <p>{data.status === 'missing' ? historical ? 'この日の在庫データはありません。' : '集計データなし' : data.status === 'expired' ? 'この集計版は参照期限を過ぎました。' : '集計を取得できませんでした。'}</p>
    {data.status !== 'missing' && <button type="button" className="analysis-button" onClick={retry}>集計を再試行</button>}
  </div>;

  const {summary,target,period,metadata} = data;
  if (metric === 'skus' && summary.skus === undefined) return <p className="analysis-note" role="status">この時点のSKU内訳の記録はありません。</p>;
  const {gross,total:chartTotal,returned,net} = chartBasis(summary,metric);
  const acquisition = target === 'acquisitions';
  const missingAmount = unknownAmount(summary,target);
  const knownAmount = summary.records === 0 || missingAmount < summary.records;
  const totals: {label:string;value:ReactNode}[] = [
    {label:metricLabel(target,'amount'),value:knownAmount ? formatMetric(summary.amount,'amount') : '—'},
  ];
  if (acquisition) totals.push({label:'確認できた仕入数量',value:formatMetric(summary.quantity,'quantity')},{label:'仕入ロット数',value:formatMetric(summary.lots,'lots')});
  const inventory = target === 'inventory';
  const prefix = target === 'retailReference' ? '直近90日の小売実績' : acquisition ? '直近30日の仕入れ' : target === 'sales' ? '選択期間の売上' : metric === 'skus' ? historical || request.daily ? 'この時点のSKU' : '現在庫のSKU' : '在庫原価の配分';
  const unknownList = [
    ...(target==='sales' ? [['売上金額未登録',missingAmount] as const] : []),
    ['原価未登録',summary.unknown.cost],['数量未確認',summary.unknown.quantity],['未分類',summary.unknown.category],
    ['種類未判定',summary.unknown.kind],['ロット未判定',summary.unknown.lot],
  ] as const;
  return <section className="analysis-result" aria-label={prefix}>
    {metric === 'skus' && <div className="analysis-sku-total">
      {!comparison && <h2>{historical || request.daily ? 'この時点のSKU' : '現在庫のSKU'}</h2>}
      <strong>{formatMetric(chartTotal,'skus')}</strong>
      <p className="analysis-note">{formatJstDateTime(metadata.asOf)} JST 時点</p>
    </div>}
    {!inventory && <div className="analysis-summary">
      <h2>{prefix}</h2>
      {showSummaryTotal && <div className="analysis-totals">{totals.map(total=><div key={total.label}><span>{total.label}</span><strong>{total.value}</strong></div>)}</div>}
      {period && <p>{period.start.replaceAll('-','/')} ～ {period.end.replaceAll('-','/')}{period.partial ? '（途中）' : ''}</p>}
      <p>{formatJstDateTime(metadata.asOf)} JST 時点</p>
      <p>{metadata.amountBasis}</p>
      {acquisition && <p>商品として仕入れた分を集計しています。販売済み・業販予定分を含みます。{metadata.unlocatedAcquisitionRecords > 0 && ' 仕入日や元明細を確認できない記録 '+metadata.unlocatedAcquisitionRecords.toLocaleString('ja-JP')+'件。'}</p>}
      {unknownList.some(([,count])=>count>0) && <p>{unknownList.filter(([,count])=>count>0).map(([label,count])=>label+' '+count.toLocaleString('ja-JP')+'件').join(' · ')}</p>}
      {gross && <p>円グラフは返品前の構成です。返品・取消 {formatMetric(returned,metric)} · 差引 {formatMetric(net,metric)}</p>}
      {target === 'retailReference' && <p>確認済みの小売実績の参考配分。販路未確認 {data.referenceExclusions.unknownChannel}件 · 原価未確認 {data.referenceExclusions.unknownCost}件 · 取得元未確認 {data.referenceExclusions.unverifiedOrigin}件 · その他の対象外 {data.referenceExclusions.excluded}件（対象外の売上 {formatMetric(data.referenceExclusions.salesAmount,'amount')}）</p>}
    </div>}
    {!inventory && toggleBands && <button type="button" className="analysis-button" aria-pressed={detailed} onClick={toggleBands}>{detailed ? '単品・複数に戻す' : '数量帯を詳しく'}</button>}
    <div className="analysis-charts">
      {chartContent(target,metric,detailed).filter(chart=>!onlyDimension || chart.dimension===onlyDimension).map(({title,dimension})=><AnalysisDonut key={metadata.generation+':'+target+':'+metric+':'+dimension}
        title={title} target={target} metric={metric} dimension={dimension} comparison={comparison} buckets={counterpart?.status==='ok' ? comparisonBuckets(summary.dimensions[dimension] ?? [],counterpart.summary.dimensions[dimension] ?? [],dimension,historical ? counterpart.summary.dimensions[dimension] ?? [] : summary.dimensions[dimension] ?? []) : summary.dimensions[dimension] ?? []}
        note={dimension === 'skuHoldingCount' ? skuHoldingNote : inventory ? '商品名による分類を含みます。' : undefined}
        denominator={inventory && metric === 'amount' ? inventoryCompositionNote(metric) : undefined}
        total={chartTotal} gross={gross} records={summary.records} missingAmount={missingAmount}
        onSelect={(row:DisplayRow)=>select({dimension,key:row.key,label:row.label,request:{...request,generation:metadata.generation}})}/>)}
    </div>
    {metric === 'skus' && showSkuNotes && <details className="analysis-sku-notes">
      <summary>SKUの集計方法</summary>
      <p>管理SKUごとに1 SKUとして集計します。</p>
      {(summary.unknownSkuRecords ?? 0) > 0 && <p>管理SKUが未登録の在庫 {summary.unknownSkuRecords?.toLocaleString('ja-JP')}件は集計の対象外です。</p>}
    </details>}
  </section>;
}
