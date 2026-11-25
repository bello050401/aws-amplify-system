import {displayRows, type Bucket,type Dimension,type Metric,type AnalysisResult} from './model';

// Both inputs are successful captures. A missing key means no stock in that capture.
export function comparisonBuckets(buckets:Bucket[],other:Bucket[],dimension:Dimension,baseline:Bucket[]=buckets):Bucket[] {
  const templates=new Map<string,Bucket>();
  for (const bucket of [...baseline,...buckets,...other]) if (!templates.has(bucket.key)) templates.set(bucket.key,bucket);
  const own=new Map(buckets.map(bucket=>[bucket.key,bucket]));
  const exact=dimension==='holdingCount'||dimension==='skuHoldingCount';
  return [...templates.values()].sort((a,b)=>exact
    ? (a.key==='__unknown__'?Infinity:Number(a.key))-(b.key==='__unknown__'?Infinity:Number(b.key))
    : 0).map(template=>own.has(template.key) ? {...own.get(template.key)!,color:template.color} : {
      key:template.key,label:template.label,color:template.color,
      amount:0,gross:0,returns:0,quantity:0,grossQuantity:0,returnedQuantity:0,kinds:0,lots:0,records:0,skus:0,
      unknown:{amount:0,cost:0,quantity:0,category:0,kind:0,lot:0,channel:0,origin:0,date:0},
    });
}

/** Both captures are aligned; unknown costs never become zero-valued changes. */
export function comparisonRows(current:Bucket[],prior:Bucket[],dimension:Dimension,metric:Metric) {
  const currentRows=displayRows(comparisonBuckets(current,prior,dimension,current),metric,false,true,false,'inventory',dimension).rows;
  const priorRows=displayRows(comparisonBuckets(prior,current,dimension,current),metric,false,true,false,'inventory',dimension).rows;
  const previous=new Map(priorRows.map(row=>[row.key,row]));
  return currentRows.map(row=>{
    const before=previous.get(row.key)!;
    const known=!row.unknownValue && !before.unknownValue;
    return {key:row.key,label:row.label,color:row.color,current:row,prior:before,
      change:known ? row.value-before.value : null,
      points:known && currentRows.some(item=>item.value>0) && priorRows.some(item=>item.value>0) ? row.percent-before.percent : null};
  });
}
export function signedChange(value:number|null,format:(value:number)=>string) {
  return value===null ? '—' : (value>0?'+':value<0?'−':'')+format(Math.abs(value));
}

export function inventoryHistorySummary(history:NonNullable<Extract<AnalysisResult,{status:'ok'}>['metadata']['inventoryHistory']>) {
  return 'SKUの確認：当時の記録 '+history.historicalIdentityRecords.toLocaleString('ja-JP')+'件・変更のない連携情報 '+history.currentIdentityRecords.toLocaleString('ja-JP')+'件。'+(history.unknownQuantityRecords>0?' 数量未確認のため対象外 '+history.unknownQuantityRecords.toLocaleString('ja-JP')+'件。':'');
}

/** Choose the sign after display rounding so tiny decreases never become −0.0pt. */
export function formatPercentagePointDelta(value:number|null) {
  if (value===null) return '—';
  return signedChange(Number(value.toFixed(1)),magnitude=>magnitude.toFixed(1)+'pt');
}
