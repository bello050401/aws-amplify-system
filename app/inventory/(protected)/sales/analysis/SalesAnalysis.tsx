'use client';

import Link from 'next/link';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
import {useRef,useState,type FormEvent,type ReactNode} from 'react';
import {formatJstDateTime} from '../../../../../lib/inventory/sales';
import {
  analysisRequest,chartBasis,chartContent,firstMonth,formatMetric,groupingFor,jstDay,metricFor,metricLabel,monthChoices,
  PERIODS,selectedSalesMonth,stateFromQuery,summaryRequest,TABS,unknownAmount,writeQuery,type AnalysisPorts,type AnalysisResult,type AnalysisState,
  type DisplayRow,type Metric,type Slice,
} from '../../../../../lib/inventory/analysisUi/model';
import {useAnalysis} from '../../../../../lib/inventory/analysisUi/useAnalysis';
import {AnalysisDetail} from './AnalysisDetail';
import {AnalysisDonut} from './AnalysisDonut';
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

export function SalesAnalysis({ports,today=jstDay(),productLinks=false,management,inventoryFallback,salesGeneration,syncLegacyMonths=false}:{
  ports?:AnalysisPorts; today?:string; productLinks?:boolean; management?:AnalysisManagementPorts; inventoryFallback?:ReactNode; syncLegacyMonths?:boolean; salesGeneration?:string|null;
}) {
  const router = useRouter();
  const query = useSearchParams();
  const pathname = usePathname();
  const state = stateFromQuery(new URLSearchParams(query),today);
  const request = analysisRequest(state,today);
  const metric = metricFor(state);
  const {key,detailed} = groupingFor(state);
  const pinned = summaryRequest(request,salesGeneration);
  const read = useAnalysis(ports?.load,state.slice ? null : pinned);
  const data = request && !pinned ? {status:'missing' as const} : read.data;
  const retry = data?.status==='expired' && salesGeneration ? ()=>router.refresh() : read.retry;
  const acquisition = state.tab === 'breakdown' && state.breakdown === 'acquisitions';
  const compare = acquisition && metric === 'amount' && data?.status === 'ok';
  const reference = useAnalysis(ports?.load,state.reference && compare ? {target:'retailReference',generation:data.metadata.generation} : null);
  const source = useRef<HTMLElement | SVGElement | null>(null);
  const content = useRef<HTMLDivElement>(null);

  function update(change:Partial<AnalysisState>, enterDetail=false) {
    const selection = {...state,slice:null,...change};
    const next = writeQuery(new URLSearchParams(query),selection);
    if (syncLegacyMonths && state.tab === 'sales' && (change.preset || change.saleMonth)) {
      const month = selectedSalesMonth(selection,today);
      if (month) {
        const [year,number] = month.split('-').map(Number);
        next.set('y',String(year));next.set('m',String(number));
        router.replace(pathname+'?'+next,{scroll:false});
        return;
      }
    }
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

  const graphs = request && <AnalysisResultView data={data} retry={retry} metric={metric} detailed={detailed}
    toggleBands={()=>update({detailed:{...state.detailed,[key]:!detailed}})} select={select} request={request}
    showSummaryTotal={state.tab !== 'inventory'}/>;
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
      {state.tab === 'breakdown' && <>
        <Choices label="在庫内訳の対象" options={[{key:'inventory',label:'現在庫'},{key:'acquisitions',label:'直近30日の仕入れ'}] as const} value={state.breakdown} select={breakdown=>update({breakdown})}/>
        {acquisition
          ? <Choices label="仕入れの集計単位" options={[{key:'amount',label:'仕入原価'},{key:'quantity',label:'仕入数量'},{key:'lots',label:'仕入ロット数'}] as const} value={state.acquisitionUnit} select={acquisitionUnit=>update({acquisitionUnit})}/>
          : <Choices label="現在庫の集計単位" options={[{key:'quantity',label:'数量'},{key:'kinds',label:'商品種類数'}] as const} value={state.stockUnit} select={stockUnit=>update({stockUnit})}/>
        }
      </>}
      {!request ? <p className="analysis-note" role="status">2026年1月1日以降で有効な開始日と終了日を指定してください。</p>
        : state.tab==='inventory'
          ? data?.status==='ok'
            ? <InventoryValueReport view={{status:'ok',value:{...data.inventoryValue,month:state.inventoryMonth || undefined}}} analysis={graphs}/>
            : <>{inventoryFallback}{graphs}</>
          : graphs}
      {compare && <>
        <button type="button" className="analysis-button" aria-expanded={state.reference} onClick={()=>update({reference:!state.reference})}>小売実績の参考配分と比較</button>
        {state.reference && <AnalysisResultView data={reference.data} retry={reference.retry} metric="amount" detailed={false} select={select} request={{target:'retailReference'}}/>}
      </>}
      {management && <AnalysisManagement ports={management}/>}
    </div>
    {state.slice && ports && <AnalysisDetail key={[state.slice.request.generation,state.slice.dimension,state.slice.key].join(':')}
      slice={state.slice} drill={ports.drill}
      onClose={close} metric={state.slice.request.target === 'retailReference' ? 'amount' : metric} productHref={productLinks ? productHref : undefined} management={management}/>}
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

function AnalysisResultView({data,retry,request,metric,detailed,toggleBands,select,showSummaryTotal=true}:{
  data:AnalysisResult|null; retry:()=>void; request:NonNullable<ReturnType<typeof analysisRequest>>;
  metric:Metric; detailed:boolean; toggleBands?:()=>void; select:(slice:Slice)=>void; showSummaryTotal?:boolean;
}) {
  if (!data) return <p className="analysis-note" role="status">集計を読み込み中…</p>;
  if (data.status !== 'ok') return <div className="analysis-card" role="status">
    <p>{data.status === 'missing' ? '集計データなし' : data.status === 'expired' ? 'この集計版は参照期限を過ぎました。' : '集計を取得できませんでした。'}</p>
    {data.status !== 'missing' && <button type="button" className="analysis-button" onClick={retry}>集計を再試行</button>}
  </div>;

  const {summary,target,period,metadata} = data;
  const {gross,total:chartTotal,returned,net} = chartBasis(summary,metric);
  const stockKind = target === 'inventory' && metric !== 'amount';
  const acquisition = target === 'acquisitions';
  const primary = stockKind ? 'quantity' : 'amount';
  const missingAmount = unknownAmount(summary,target);
  const knownAmount = summary.records === 0 || missingAmount < summary.records;
  const totals: {label:string;value:ReactNode}[] = [
    {label:metricLabel(target,primary),value:primary === 'amount' && !knownAmount ? '—' : formatMetric(summary[primary],primary)},
  ];
  if (stockKind) totals.push({label:'確認済みの商品種類数',value:formatMetric(summary.kinds,'kinds')});
  if (acquisition) totals.push({label:'確認できた仕入数量',value:formatMetric(summary.quantity,'quantity')},{label:'仕入ロット数',value:formatMetric(summary.lots,'lots')});
  const prefix = target === 'retailReference' ? '直近90日の小売実績' : acquisition ? '直近30日の仕入れ' : target === 'sales' ? '選択期間の売上' : stockKind ? '現在庫' : '在庫原価分析';
  const unknownList = [
    ...(target==='sales' ? [['売上金額未登録',missingAmount] as const] : []),
    ['原価未登録',summary.unknown.cost],['数量未確認',summary.unknown.quantity],['未分類',summary.unknown.category],
    ['種類未判定',summary.unknown.kind],['ロット未判定',summary.unknown.lot],
  ] as const;
  return <section className="analysis-result" aria-label={prefix}>
    <div className="analysis-summary">
      <h2>{prefix}</h2>
      {showSummaryTotal && <div className="analysis-totals">{totals.map(total=><div key={total.label}><span>{total.label}</span><strong>{total.value}</strong></div>)}</div>}
      {period && <p>{period.start.replaceAll('-','/')} ～ {period.end.replaceAll('-','/')}{period.partial ? '（途中）' : ''}</p>}
      <p>{formatJstDateTime(metadata.asOf)} JST 時点</p>
      <p>{metadata.amountBasis}</p>
      {acquisition && <p>商品として仕入れた分を集計しています。販売済み・業販予定分を含みます。{metadata.unlocatedAcquisitionRecords > 0 && ' 仕入日や元明細を確認できない記録 '+metadata.unlocatedAcquisitionRecords.toLocaleString('ja-JP')+'件。'}</p>}
      {unknownList.some(([,count])=>count>0) && <p>{unknownList.filter(([,count])=>count>0).map(([label,count])=>label+' '+count.toLocaleString('ja-JP')+'件').join(' · ')}</p>}
      {gross && <p>円グラフは返品前の構成です。返品・取消 {formatMetric(returned,metric)} · 差引 {formatMetric(net,metric)}</p>}
      {target === 'retailReference' && <p>確認済みの小売実績の参考配分。販路未確認 {data.referenceExclusions.unknownChannel}件 · 原価未確認 {data.referenceExclusions.unknownCost}件 · 取得元未確認 {data.referenceExclusions.unverifiedOrigin}件 · その他の対象外 {data.referenceExclusions.excluded}件（対象外の売上 {formatMetric(data.referenceExclusions.salesAmount,'amount')}）</p>}
    </div>
    {toggleBands && <button type="button" className="analysis-button" aria-pressed={detailed} onClick={toggleBands}>{detailed ? '単品・複数に戻す' : '数量帯を詳しく'}</button>}
    <div className="analysis-charts">
      {chartContent(target,metric,detailed).map(({title,dimension})=><AnalysisDonut key={metadata.generation+':'+target+':'+metric+':'+dimension}
        title={title} target={target} metric={metric} buckets={summary.dimensions[dimension] ?? []}
        total={chartTotal} gross={gross} records={summary.records} missingAmount={missingAmount}
        onSelect={(row:DisplayRow)=>select({dimension,key:row.key,label:row.label,request:{...request,generation:metadata.generation}})}/>)}
    </div>
  </section>;
} 
