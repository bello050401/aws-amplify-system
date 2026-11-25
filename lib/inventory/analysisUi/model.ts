import type {AnalysisRequest, AnalysisResult, Bucket, DetailItem as CoreDetailItem, DetailRecord, DetailResult as CoreDetailResult, Dimension, DrilldownRequest, Fact, Metric, Target, Totals} from '../analysis/types';
import {dateOnly, jstDay as capturedJstDay} from '../analysis/period';

export type {AnalysisRequest, AnalysisResult, Bucket, DetailItem as CoreDetailItem, DetailRecord, DetailResult as CoreDetailResult, Dimension, DrilldownRequest, Fact, Metric, Target, Totals};

export interface ProductFact extends DetailRecord {
  imageUrl?: string | null;
}
type CoreGroup = Extract<CoreDetailItem,{type:'group'}>['group'];
export interface ProductGroup extends CoreGroup {
  representative: ProductFact;
}
type CoreSkuGroup = Extract<CoreDetailItem,{type:'sku-group'}>['group'];
export interface SkuGroup extends CoreSkuGroup {
  representative: ProductFact;
}
export type DetailItem = {type:'record'; record:ProductFact} | {type:'group'; group:ProductGroup} | {type:'sku-group'; group:SkuGroup};
export type DetailGroup = Pick<DrilldownRequest,'groupKindId'|'groupSku'>;
export function detailItemKey(item:DetailItem) {
  if (item.type === 'record') return 'record:'+item.record.id;
  return item.type === 'group' ? 'kind:'+item.group.kindId : 'sku:'+item.group.groupKey;
}
export type DetailResult =
  | (Omit<Extract<CoreDetailResult,{status:'ok'}>,'items'> & {items:DetailItem[]})
  | Exclude<CoreDetailResult,{status:'ok'}>;

export type AnalysisTransport = {operation:'summary';request:AnalysisRequest} | {operation:'detail';request:DrilldownRequest};

export interface AnalysisPorts {
  load: (request:AnalysisRequest) => Promise<AnalysisResult>;
  drill: (request:DrilldownRequest) => Promise<DetailResult>;
}

export const TABS = [
  {key:'sales', label:'売上'},
  {key:'inventory', label:'在庫金額'},
  {key:'breakdown', label:'SKU内訳'},
] as const;
export type Tab = typeof TABS[number]['key'];

export const PERIODS = [
  {key:'current', label:'当月'},
  {key:'previous', label:'前月'},
  {key:'rolling', label:'直近30日'},
  {key:'month', label:'月指定'},
  {key:'custom', label:'期間指定'},
] as const;
export type Preset = typeof PERIODS[number]['key'];
export type InventoryCompareWeeks = 0|2|3|4;

export interface Slice {
  dimension: Dimension;
  key: string;
  label: string;
  request: AnalysisRequest & {generation:string};
}
export interface AnalysisState {
  tab: Tab;
  preset: Preset;
  saleMonth: string;
  start: string;
  end: string;
  inventoryMonth: string;
  inventoryCompareWeeks: InventoryCompareWeeks;
  breakdown: 'inventory'|'acquisitions';
  stockUnit: 'quantity'|'kinds';
  acquisitionUnit: 'amount'|'quantity'|'lots';
  detailed: Record<'sales'|'inventory'|'breakdown'|'acquisitions',boolean>;
  reference: boolean;
  slice: Slice | null;
}

const monthFormat = /^\d{4}-(0[1-9]|1[0-2])$/;
const firstDay = '2026-01-01';
export const firstMonth = firstDay.slice(0,7);
const dayMilliseconds = 86_400_000;
export function jstDay(now:Date = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0,10);
}
function validDay(value:string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0,10) === value;
}
function shiftDay(day:string, delta:number) {
  return new Date(Date.parse(day) + delta * dayMilliseconds).toISOString().slice(0,10);
}
export function shiftMonth(month:string, delta:number) {
  const date = new Date(month + '-01');
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0,7);
}
function monthEnd(month:string) {
  return shiftDay(shiftMonth(month,1) + '-01',-1);
}
export function monthChoices(today:string) {
  const months:string[] = [];
  for (let month = today.slice(0,7); month >= firstMonth; month = shiftMonth(month,-1)) months.push(month);
  return months;
}

export const initialAnalysisState = (today:string):AnalysisState => ({
  tab:'sales', preset:'current', saleMonth:today.slice(0,7), start:today.slice(0,7)+'-01', end:today,
  inventoryMonth:'', inventoryCompareWeeks:0, breakdown:'inventory', stockUnit:'quantity', acquisitionUnit:'amount',
  detailed:{sales:false,inventory:false,breakdown:false,acquisitions:false}, reference:false, slice:null,
});

export function stateFromQuery(query:URLSearchParams, today:string):AnalysisState {
  const state = initialAnalysisState(today);
  const get = (key:string) => query.get(key) ?? '';
  const view = get('view');
  if (view === 'inventory' || view === 'breakdown') state.tab = view;
  // Keep existing month links meaningful for dates covered by analysis.
  const oldMonth = get('y') + '-' + get('m').padStart(2,'0');
  const selectedMonth = get('salesMonth') || oldMonth;
  if (monthFormat.test(selectedMonth) && selectedMonth >= firstMonth && selectedMonth <= today.slice(0,7)) {
    state.saleMonth = selectedMonth;
    if (selectedMonth !== today.slice(0,7)) state.preset = 'month';
  }
  const preset = PERIODS.find(option => option.key === get('period'));
  if (preset) state.preset = preset.key;
  if (validDay(get('start'))) state.start = get('start');
  if (validDay(get('end'))) state.end = get('end');
  if (monthFormat.test(get('month'))) state.inventoryMonth = get('month');
  const compareWeeks = get('compareWeeks');
  if (compareWeeks === '2' || compareWeeks === '3' || compareWeeks === '4') state.inventoryCompareWeeks = Number(compareWeeks) as InventoryCompareWeeks;
  if (get('breakdown') === 'acquisitions') state.breakdown = 'acquisitions';
  if (get('stockUnit') === 'kinds') state.stockUnit = 'kinds';
  const unit = get('acquisitionUnit');
  if (unit === 'quantity' || unit === 'lots') state.acquisitionUnit = unit;
  for (const key of Object.keys(state.detailed) as (keyof AnalysisState['detailed'])[]) state.detailed[key] = get('bands-'+key) === '1';
  state.reference = get('reference') === '1';
  const dimension = get('dimension');
  const generation = get('generation').slice(0,128);
  const key = get('slice').slice(0,160);
  const skuDimension = dimension === 'skuCategory' || dimension === 'skuHoldingCount';
  const request = skuDimension && state.tab === 'breakdown'
    ? {target:'inventory' as const}
    : get('detailTarget') === 'retailReference' && state.tab === 'breakdown' && state.breakdown === 'acquisitions' && state.reference
      ? {target:'retailReference' as const}
      : analysisRequest(state,today);
  if (request && generation && key && isDimension(dimension)) {
    const start = get('detailStart'), end = get('detailEnd'), daily = get('detailDaily');
    if (request.target === 'inventory' && daily && !validDay(daily)) return state;
    const exact = request.target === 'sales' && validDay(start) && validDay(end) && start <= end ? {...request,start,end} : request;
    const historical = exact.target === 'inventory' && validDay(daily) ? {...exact,daily} : exact;
    state.slice = {dimension,key,label:get('sliceLabel').slice(0,160) || key,request:{...historical,generation}};
  }
  return state;
}

function isDimension(value:string):value is Dimension {
  return ['category','holding','holdingBand','holdingCount','skuCategory','skuHoldingCount','lot','lotBand'].includes(value);
}

export function writeQuery(query:URLSearchParams, state:AnalysisState) {
  const fields:Record<string,string> = {
    view:state.tab === 'sales' ? '' : state.tab,
    period:state.preset, salesMonth:state.saleMonth, start:state.start, end:state.end,
    month:state.inventoryMonth, breakdown:state.breakdown, stockUnit:state.stockUnit, acquisitionUnit:state.acquisitionUnit,
    compareWeeks:state.inventoryCompareWeeks ? String(state.inventoryCompareWeeks) : '',
    reference:state.reference ? '1' : '',
    dimension:state.slice?.dimension ?? '', slice:state.slice?.key ?? '', sliceLabel:state.slice?.label ?? '',
    generation:state.slice?.request.generation ?? '',
    detailTarget:state.slice?.request.target === 'retailReference' ? 'retailReference' : '',
    detailStart:state.slice?.request.start ?? '', detailEnd:state.slice?.request.end ?? '',
    detailDaily:state.slice?.request.daily ?? '',
  };
  for (const [key,value] of Object.entries(state.detailed)) fields['bands-'+key] = value ? '1' : '';
  for (const [key,value] of Object.entries(fields)) {
    if (value) query.set(key,value);
    else query.delete(key);
  }
  return query;
}

// Rebuild return links on a fixed route and only copy the supported query fields.
export function analysisReturnHref(raw:string|undefined, today:string) {
  if (typeof raw !== 'string' || raw.length > 3000) return null;
  const original = new URLSearchParams(raw);
  const details = writeQuery(new URLSearchParams(),stateFromQuery(original,today));
  for (const key of ['y','m']) {
    const value = original.get(key);
    if (value && /^\d{1,4}$/.test(value)) details.set(key,value);
  }
  return '/inventory/sales?' + details.toString();
}

export function analysisRequest(state:AnalysisState,today:string):AnalysisRequest | null {
  if (state.tab === 'inventory') return {
    target:'inventory',
    ...(state.inventoryMonth ? {daily:monthEnd(state.inventoryMonth)} : {}),
  };
  if (state.tab === 'breakdown') return {target:state.breakdown};
  const current = today.slice(0,7);
  if (state.preset === 'rolling') return {target:'sales',rollingDays:30};
  if (state.preset === 'custom') {
    if (!validDay(state.start) || !validDay(state.end) || state.start > state.end || state.start < firstDay || state.end > today || (Date.parse(state.end)-Date.parse(state.start))/dayMilliseconds > 3660) return null;
    return {target:'sales',start:state.start,end:state.end};
  }
  const month = state.preset === 'month' ? state.saleMonth : state.preset === 'previous' ? shiftMonth(current,-1) : current;
  if (!monthFormat.test(month)) return null;
  return {target:'sales',start:month+'-01',end:monthEnd(month)};
}

/** A null sales generation means the paired monthly snapshot was unavailable. */
export function summaryRequest(request:AnalysisRequest|null,salesGeneration?:string|null):AnalysisRequest|null {
  if (!request || request.target !== 'sales' || salesGeneration === undefined) return request;
  return salesGeneration ? {...request,generation:salesGeneration} : null;
}

/** Compare captured inventory on exact JST calendar days, never a reconstructed current balance. */
export function comparisonDay(anchorDay:string,weeks:Exclude<InventoryCompareWeeks,0>):string {
  dateOnly(anchorDay);
  if (weeks !== 2 && weeks !== 3 && weeks !== 4) throw new Error('INVALID_COMPARISON_WEEKS');
  return shiftDay(anchorDay,-7*weeks);
}

export function inventoryComparisonRequest(asOf:string,weeks:Exclude<InventoryCompareWeeks,0>):AnalysisRequest {
  return {target:'inventory',daily:comparisonDay(capturedJstDay(asOf),weeks)};
}

/** Refuse a transport response for a different capture rather than mixing periods. */
export function matchingAnalysisResult(request:AnalysisRequest,result:AnalysisResult):AnalysisResult {
  if (result.status !== 'ok') return result;
  if (request.generation && result.metadata.generation !== request.generation) return {status:'expired'};
  if (result.target !== request.target || (request.daily && result.metadata.coverageEnd !== request.daily)) return {status:'error'};
  return result;
}

export function unknownAmount(totals:Totals,target:Target) {
  // Older generations recorded cost coverage only. Sale prices are independent of cost.
  return totals.unknown.amount ?? (target==='sales' ? 0 : totals.unknown.cost);
}

export function metricFor(state:AnalysisState):Metric {
  if (state.tab !== 'breakdown') return 'amount';
  return state.breakdown === 'inventory' ? 'skus' : state.acquisitionUnit;
}
export function groupingFor(state:AnalysisState) {
  const key = state.tab === 'breakdown' && state.breakdown === 'acquisitions' ? 'acquisitions' : state.tab;
  return {key,detailed:state.detailed[key]};
}

export function detailMetricFor(slice:Slice, state:AnalysisState):Metric {
  if (slice.dimension === 'skuCategory' || slice.dimension === 'skuHoldingCount') return 'skus';
  if (slice.request.target === 'retailReference') return 'amount';
  if (slice.request.target === 'inventory' && state.tab === 'breakdown') return state.stockUnit;
  return metricFor(state);
}

export function metricLabel(target:Target,metric:Metric) {
  if (metric === 'skus') return 'SKU数';
  if (metric === 'quantity') return target === 'acquisitions' ? '仕入数量' : target === 'inventory' ? '在庫数量' : '数量';
  if (metric === 'kinds') return '商品種類数';
  if (metric === 'lots') return '仕入ロット数';
  if (target === 'sales') return '売上';
  if (target === 'acquisitions') return '仕入原価';
  return target === 'retailReference' ? '小売売却原価' : '在庫金額';
}
export function formatMetric(value:number, metric:Metric) {
  return metric === 'amount'
    ? (value < 0 ? '−' : '') + '¥' + Math.abs(value).toLocaleString('ja-JP')
    : value.toLocaleString('ja-JP') + (metric === 'skus' ? ' SKU' : metric === 'quantity' ? '点' : metric === 'kinds' ? '種類' : 'ロット');
}

export interface DisplayRow {
  key: string;
  label: string;
  color: string;
  value: number;
  percent: number;
  quantity?: number;
  unknownValue?:boolean;
  categories?: DisplayRow[];
}
const unknownKey = '__unknown__';
function compositionValue(totals:Totals,metric:Metric,gross:boolean) {
  if (gross && metric==='amount') return totals.gross;
  if (gross && metric==='quantity') return totals.grossQuantity ?? Math.max(0,totals.quantity);
  return totals[metric] ?? 0;
}

export function chartBasis(summary:Totals,metric:Metric) {
  const returned = metric==='amount' ? Math.abs(summary.returns) : metric==='quantity' ? summary.returnedQuantity ?? 0 : 0;
  const gross = returned>0 && (metric==='amount' || metric==='quantity');
  return {gross,total:compositionValue(summary,metric,gross),returned,net:summary[metric] ?? 0};
}

export function displayRows(buckets:Bucket[], metric:Metric, gross:boolean, showAll:boolean, category:boolean,target:Target='inventory',dimension?:Dimension) {
  const value = (bucket:Bucket) => compositionValue(bucket,metric,gross);
  const exact = dimension === 'holdingCount' || dimension === 'skuHoldingCount';
  const inventoryCategory = target === 'inventory' && (dimension === 'category' || dimension === 'skuCategory');
  const sorted = inventoryCategory ? buckets : [...buckets].sort(exact
    ? (a,b)=>(a.key===unknownKey ? Infinity : Number(a.key))-(b.key===unknownKey ? Infinity : Number(b.key))
    : (a,b)=>value(b)-value(a));
  const total = sorted.reduce((sum,bucket)=>sum+Math.max(0,value(bucket)),0);
  const rows:DisplayRow[] = sorted.map(bucket=>({
    key:bucket.key,label:bucket.label,
    color:bucket.color,
    value:value(bucket),
    percent:total > 0 ? Math.max(0,value(bucket))/total*100 : 0,
    ...(metric === 'amount' && target !== 'inventory' && bucket.quantity > 0 ? {quantity:bucket.quantity} : {}),
    unknownValue:metric === 'amount' && bucket.records > 0 && unknownAmount(bucket,target) >= bucket.records,
  }));
  const classified = rows.filter(row=>row.key!==unknownKey);
  const others = classified.slice(5);
  if (inventoryCategory) return {rows,expandable:false};
  if (showAll || !category || others.length < 2) return {rows, expandable:category && others.length >= 2};
  const other:DisplayRow = {
    key:'__other_categories__',label:'他のカテゴリー',color:'#a6ada9',categories:others,
    value:others.reduce((sum,row)=>sum+row.value,0),
    unknownValue:others.every(row=>row.unknownValue),
    percent:others.reduce((sum,row)=>sum+row.percent,0),
    quantity:others.some(row=>row.quantity!==undefined) ? others.reduce((sum,row)=>sum+(row.quantity??0),0) : undefined,
  };
  return {rows:[...classified.slice(0,5),other,...rows.filter(row=>row.key===unknownKey)],expandable:true};
}

export function graphSegments(rows:DisplayRow[]) {
  let offset = 0;
  return rows.filter(row=>row.percent>0).map(row=>{
    const segment = {...row,offset};
    offset += row.percent;
    return segment;
  });
}

export const skuHoldingNote = '同じSKUの在庫数を合算して区分します。';

export function inventoryCompositionNote(metric:Metric) {
  if (metric === 'skus') return '割合は在庫のSKU数全体に対する比率です。';
  if (metric === 'amount') return '割合の分母は、購入単価が確認できる在庫の金額合計です。';
  if (metric === 'kinds') return '割合の分母は、確認済みの商品種類数の合計です。';
  return '割合の分母は、集計時点の在庫数量の合計です。';
}

export function categoryBasisLabel(basis:Fact['categoryBasis']) {
  if (basis === 'title') return '商品名による分類';
  if (basis === 'confirmed') return '確認済みのカテゴリー';
  return undefined;
}

export function holdingBasisLabel(basis:Fact['holdingBasis']) {
  if (basis === 'confirmed-kind') return '同一商品として合算';
  if (basis === 'inventory-record') return '未照合・商品ページの在庫数';
  if (basis === 'unknown') return '保有数不明';
  return undefined;
}

export function chartContent(target:Target,metric:Metric,bands:boolean):{title:string; dimension:Dimension}[] {
  if (target === 'sales') return [
    {title:'カテゴリー別の売上',dimension:'category'},
    {title:'単品仕入れと複数仕入れの売上',dimension:bands ? 'lotBand' : 'lot'},
  ];
  if (target === 'acquisitions') return [
    {title:'カテゴリー別の'+metricLabel(target,metric),dimension:'category'},
    {title:'単品と複数の仕入ロット配分',dimension:bands ? 'lotBand' : 'lot'},
  ];
  if (target === 'retailReference') return [{title:'カテゴリー別の小売実績の参考配分',dimension:'category'}];
  if (metric === 'skus') return [
    {title:'カテゴリー別のSKU数',dimension:'skuCategory'},
    {title:'保有数別のSKU数',dimension:'skuHoldingCount'},
  ];
  return [{title:'カテゴリー別の在庫金額',dimension:'category'}];
}


export function arcPath(percent:number,offset:number,radius=88,center=110) {
  if (percent>=100) return 'M '+center+' '+(center-radius)+' a '+radius+' '+radius+' 0 1 1 0 '+(2*radius)+' a '+radius+' '+radius+' 0 1 1 0 '+(-2*radius);
  const point = (position:number) => {
    const angle = 2*Math.PI*position/100;
    return (center+radius*Math.sin(angle))+' '+(center-radius*Math.cos(angle));
  };
  return 'M '+point(offset)+' A '+radius+' '+radius+' 0 '+(percent > 50 ? 1 : 0)+' 1 '+point(offset+percent);
}
