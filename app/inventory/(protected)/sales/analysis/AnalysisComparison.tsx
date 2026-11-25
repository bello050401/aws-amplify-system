'use client';
import {arcPath,chartBasis,chartContent,formatMetric,graphSegments,inventoryCompositionNote,skuHoldingNote,unknownAmount,type AnalysisResult,type AnalysisRequest,type Metric,type Slice} from '../../../../../lib/inventory/analysisUi/model';
import {formatJstDateTime} from '../../../../../lib/inventory/sales';
import {comparisonRows,signedChange,formatPercentagePointDelta,inventoryHistorySummary} from '../../../../../lib/inventory/analysisUi/comparison';
type Capture=Extract<AnalysisResult,{status:'ok'}>;
export function AnalysisComparison({current,prior,currentRequest,priorRequest,metric,detailed,select}:{current:Capture;prior:Capture;currentRequest:AnalysisRequest;priorRequest:AnalysisRequest;metric:Metric;detailed:boolean;select:(slice:Slice)=>void}) {
  const day=(capture:Capture)=>capture.metadata.coverageEnd.replaceAll('-','/');
  return <div className="analysis-paired-comparison">
    <p className="analysis-note">過去 {day(prior)} → 現在 {day(current)}</p>
    {prior.metadata.inventoryHistory && <details className="analysis-sku-notes"><summary>過去は復元データ</summary><p>当時の記録から在庫を復元しています。</p><p>{inventoryHistorySummary(prior.metadata.inventoryHistory)}</p><p>{prior.metadata.inventoryHistory.limitations.join(' ')}</p></details>}
    {chartContent('inventory',metric,detailed).map(({title,dimension})=>{
      const rows=comparisonRows(current.summary.dimensions[dimension]??[],prior.summary.dimensions[dimension]??[],dimension,metric);
      const open=(period:'prior'|'current',key:string,label:string)=>select({dimension,key,label,request:{...(period==='prior'?priorRequest:currentRequest),generation:(period==='prior'?prior:current).metadata.generation}});
      const known=(capture:Capture)=>metric!=='amount'||capture.summary.records===0||unknownAmount(capture.summary,'inventory')<capture.summary.records;
      const totalChange=known(current)&&known(prior)?chartBasis(current.summary,metric).total-chartBasis(prior.summary,metric).total:null;
      return <section key={dimension} className="analysis-card analysis-paired-card" aria-label={title+'の比較'}>
        <h3>{title}</h3>
        <div className="analysis-paired-rings">{(['prior','current'] as const).map(period=>{
          const capture=period==='prior'?prior:current;
          const segments=rows.map(row=>row[period]);
          return <div key={period} className="analysis-paired-period"><h4>{period==='prior'?'過去':'現在'} <small>{formatJstDateTime(capture.metadata.asOf)} JST</small></h4>
            <div className="analysis-ring"><svg viewBox="0 0 220 220" role="group" aria-label={(period==='prior'?'過去':'現在')+'・'+title+'・円グラフ'}>
              <circle cx="110" cy="110" r="88" fill="none" stroke="#e9eeeb" strokeWidth="24"/>
              {graphSegments(segments).map(segment=><path key={segment.key} d={arcPath(segment.percent,segment.offset)} fill="none" stroke={segment.color} strokeWidth="24" role="button" tabIndex={0} className="analysis-arc" aria-label={(period==='prior'?'過去':'現在')+'の'+segment.label+'の内訳を開く'} onClick={()=>open(period,segment.key,segment.label)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open(period,segment.key,segment.label);}}}/>)}
            </svg><div className="analysis-ring-center"><span>{metric==='skus'?'SKU数':'在庫金額'}</span><strong>{known(capture)?formatMetric(chartBasis(capture.summary,metric).total,metric):'—'}</strong></div></div>
          </div>;
        })}</div>
        <p className="analysis-comparison-total">合計の増減 <strong>{signedChange(totalChange,value=>formatMetric(value,metric))}</strong></p>
        <div className="analysis-paired-table" role="table" aria-label={title+'・過去と現在の増減'}>
          <div className="analysis-paired-row analysis-paired-header" role="row"><span role="columnheader">区分</span><span role="columnheader">過去</span><span role="columnheader">現在</span><span role="columnheader">増減</span></div>
          {rows.map(row=><div className="analysis-paired-row" role="row" key={row.key}>
            <span role="rowheader" className="analysis-paired-label"><span className="analysis-dot" style={{backgroundColor:row.color}}/>{row.label}</span>
            {(['prior','current'] as const).map(period=><div role="cell" key={period}><button type="button" className="analysis-paired-value" aria-label={(period==='prior'?'過去':'現在')+'の'+row.label+' '+(row[period].unknownValue?'金額未確認':formatMetric(row[period].value,metric))+'の内訳を開く'} onClick={()=>open(period,row.key,row.label)}><strong>{row[period].unknownValue?'—':formatMetric(row[period].value,metric)}</strong><small>{row[period].unknownValue?'未確認':row[period].percent.toFixed(1)+'%'}</small></button></div>)}
            <div role="cell" className="analysis-paired-change" data-direction={row.change===null?'unknown':row.change>0?'increase':row.change<0?'decrease':'same'}><strong>{signedChange(row.change,value=>formatMetric(value,metric))}</strong><small>{formatPercentagePointDelta(row.points)}</small></div>
          </div>)}
        </div>
        {(current.summary.unknown.cost>0 || prior.summary.unknown.cost>0) && metric==='amount' && <p className="analysis-note">確認できた原価で比較しています。原価未登録：過去 {prior.summary.unknown.cost}件・現在 {current.summary.unknown.cost}件。</p>}
        {metric==='skus' && ((current.summary.unknownSkuRecords??0)>0 || (prior.summary.unknownSkuRecords??0)>0) && <p className="analysis-note">管理SKU未登録のため対象外：過去 {prior.summary.unknownSkuRecords??0}件・現在 {current.summary.unknownSkuRecords??0}件。</p>}
        <p className="analysis-note">{dimension==='skuHoldingCount'?skuHoldingNote:metric==='amount'?inventoryCompositionNote(metric):'管理SKUごとに1 SKUとして集計します。'} 増減は現在−過去、ptは構成比の差です。</p>
      </section>;
    })}
  </div>;
}
