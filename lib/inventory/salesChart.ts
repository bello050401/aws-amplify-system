import type {SalesTrendPoint} from './salesViewTypes';

/** A shared signed scale keeps both bars and the zero baseline comparable. */
export function salesChart(points:SalesTrendPoint[], width=640, height=220) {
  const padding = {top:16,right:8,bottom:24,left:8};
  const values = points.filter(point=>point.status==='ok').flatMap(point=>[point.totalSales,point.totalGrossProfit]);
  const max = Math.max(1,...values);
  const min = Math.min(0,...values);
  const plotWidth = width-padding.left-padding.right;
  const plotHeight = height-padding.top-padding.bottom;
  const slot = plotWidth/Math.max(1,points.length);
  const xFor = (index:number) => padding.left+(index+.5)*slot;
  const yFor = (value:number) => padding.top+plotHeight-(value-min)/(max-min)*plotHeight;
  const zero = yFor(0);
  const barWidth = slot*.29;
  function bar(index:number,value:number,series:'sales'|'profit') {
    const x = xFor(index)+(series==='sales' ? -barWidth-1 : 1);
    const y = value===0 ? zero-1 : Math.min(zero,yFor(value));
    return {x,y,width:barWidth,height:value===0 ? 2 : Math.abs(zero-yFor(value))};
  }
  return {padding,plotHeight,slot,xFor,zero,bar};
}

export function salesTrendLabel(point:SalesTrendPoint) {
  const yen = (value:number) => '¥'+value.toLocaleString('ja-JP');
  const status = point.status==='ok' ? '売上高 '+yen(point.totalSales)+' / 粗利益 '+yen(point.totalGrossProfit)
    : point.status==='missing' ? '未集計' : '取得エラー';
  return point.year+'年'+point.month+'月: '+status;
}
