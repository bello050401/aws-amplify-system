'use client';

import {useId,useState} from 'react';
import {
  arcPath,displayRows,formatMetric,graphSegments,metricLabel,type Bucket,type Dimension,type DisplayRow,type Metric,type Target,
} from '../../../../../lib/inventory/analysisUi/model';

export function AnalysisDonut({title,target,metric,dimension,buckets,total,gross,records,missingAmount,note,denominator,onSelect}:{
  title:string; target:Target; metric:Metric; dimension:Dimension; buckets:Bucket[]; total:number; gross:boolean;
  note?:string; denominator?:string;
  records:number; missingAmount:number; onSelect:(row:DisplayRow)=>void;
}) {
  const [showAll,setShowAll] = useState(false);
  const [other,setOther] = useState<DisplayRow[]|null>(null);
  const legendId = useId();
  const category = dimension === 'category' || dimension === 'skuCategory';
  const {rows,expandable} = displayRows(buckets,metric,gross,showAll,category,target,dimension);
  const label = metricLabel(target,metric) + (gross ? '（返品前）' : '');
  const unknown = metric === 'amount' && records > 0 && missingAmount >= records;
  const value = unknown ? '—' : formatMetric(total,metric);
  function select(row:DisplayRow) {
    if (row.categories) setOther(previous=>previous ? null : row.categories!);
    else onSelect(row);
  }

  return <section className="analysis-card analysis-chart" aria-label={title}>
    <h3>{title}</h3>
    {note && <p className="analysis-note analysis-chart-note">{note}</p>}
    <div className="analysis-chart-body">
      <div className="analysis-ring">
        <svg viewBox="0 0 220 220" role="group" aria-label={title + '・円グラフ'}>
          <circle cx="110" cy="110" r="88" fill="none" stroke="#e9eeeb" strokeWidth="24"/>
          {graphSegments(rows).map(segment=><path key={segment.key} d={arcPath(segment.percent,segment.offset)} fill="none"
            stroke={segment.color} strokeWidth="24" role="button" tabIndex={0}
            aria-label={segment.label + 'の円グラフから内訳を開く'} className="analysis-arc"
            onClick={()=>select(segment)}
            onKeyDown={event=>{if (event.key === 'Enter' || event.key === ' ') {event.preventDefault();select(segment);}}}
          />)}
        </svg>
        <div className="analysis-ring-center"><span>{label}</span><strong>{value}</strong></div>
      </div>
      <div id={legendId} className="analysis-legend-list">
        {records === 0 ? <p className="analysis-note">対象データなし</p> : unknown
          ? <p className="analysis-note">{target === 'sales' ? '売上金額' : '原価'}未登録のため金額割合を表示できません。</p>
          : total === 0 && <p className="analysis-note">構成比を表示できる{label}がありません。</p>}
        {rows.map(row=><button type="button" key={row.key} className="analysis-legend"
          aria-expanded={row.categories ? Boolean(other) : undefined} onClick={()=>select(row)}>
          <span className="analysis-dot" style={{backgroundColor:row.color}} aria-hidden="true"/>
          <span className="analysis-legend-label">
            <span>{row.label}</span>
            {row.quantity !== undefined && <small>{formatMetric(row.quantity,'quantity')}</small>}
          </span>
          <strong className="analysis-legend-value">{row.unknownValue ? '—' : formatMetric(row.value,metric)}</strong>
          <small className="analysis-legend-percent">{total > 0 && !row.unknownValue ? row.percent.toFixed(1)+'%' : '—'}</small>
        </button>)}
        {other && !showAll && <div className="analysis-other" aria-label="他のカテゴリーの内訳">{other.map(row=>
          <button type="button" className="analysis-button" key={row.key} onClick={()=>onSelect(row)}>{row.label}</button>)}</div>}
      </div>
    </div>
    {denominator && <p className="analysis-note analysis-chart-note">{denominator}</p>}
    {expandable && <button type="button" className="analysis-button" aria-expanded={showAll} aria-controls={legendId} onClick={()=>{setOther(null);setShowAll(value=>!value);}}>{showAll?'上位カテゴリーに戻す':'すべて見る'}</button>}
  </section>;
}
