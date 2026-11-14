"use client";

import {useState} from "react";
import type {SalesTrendPoint} from "../../../../lib/inventory/salesViewTypes";
import {salesChart,salesTrendLabel} from "../../../../lib/inventory/salesChart";

const width=640;
const height=220;
export function SalesTrendChart({points}:{points:SalesTrendPoint[]}) {
  const [active,setActive] = useState<number|null>(null);
  const chart = salesChart(points,width,height);
  const selected = active===null ? null : points[active];
  return <div>
    <div className="mb-2 flex gap-4 text-xs text-gray-600">
      <span><span aria-hidden className="mr-1 inline-block size-2 bg-gray-900"/>売上高</span>
      <span><span aria-hidden className="mr-1 inline-block size-2 bg-emerald-500"/>粗利益</span>
    </div>
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="group" aria-label="直近12ヶ月の売上高・粗利益の棒グラフ">
      <line x1={chart.padding.left} x2={width-chart.padding.right} y1={chart.zero} y2={chart.zero} stroke="#d1d5db"/>
      {points.map((point,index)=><g key={`${point.year}-${point.month}`}>
        <text x={chart.xFor(index)} y={height-6} textAnchor="middle" fill="#526359" fontSize="16">
          {point.month===1 ? `${String(point.year).slice(-2)}/1` : point.month}
        </text>
        {point.status==='ok' ? <>
          <rect {...chart.bar(index,point.totalSales,'sales')} fill="#111827"/>
          <rect {...chart.bar(index,point.totalGrossProfit,'profit')} fill="#10b981"/>
        </> : <circle cx={chart.xFor(index)} cy={chart.zero} r={4} fill="white" stroke={point.status==='error' ? '#dc2626' : '#9ca3af'} strokeWidth={2}/>}
        <rect x={chart.xFor(index)-chart.slot/2} y={chart.padding.top} width={chart.slot} height={chart.plotHeight}
          fill={active===index ? '#263c3517' : 'transparent'} role="button" tabIndex={0} aria-label={salesTrendLabel(point)}
          onFocus={()=>setActive(index)} onMouseEnter={()=>setActive(index)} onClick={()=>setActive(index)}
          onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setActive(index);}}}>
          <title>{salesTrendLabel(point)}</title>
        </rect>
      </g>)}
    </svg>
    <p className="mt-2 min-h-9 text-xs text-gray-600" aria-live="polite">{selected ? salesTrendLabel(selected) : 'グラフの月を選ぶと金額を表示します'}</p>
  </div>;
}

export function SalesTrendDisclosure({points}:{points:SalesTrendPoint[]}) {
  return <details className="mb-6 max-w-3xl rounded-xl border border-gray-200 px-3 py-1">
    <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold text-gray-600">直近12ヶ月の推移</summary>
    <SalesTrendChart points={points}/>
  </details>;
}
