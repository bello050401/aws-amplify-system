import type {Bucket,Dimension} from './model';

// Both inputs are successful captures. A missing key means no stock in that capture.
export function comparisonBuckets(buckets:Bucket[],other:Bucket[],dimension:Dimension,baseline:Bucket[]=buckets):Bucket[] {
  const templates=new Map([...baseline,...buckets,...other].map(bucket=>[bucket.key,bucket]));
  const own=new Map(buckets.map(bucket=>[bucket.key,bucket]));
  const exact=dimension==='holdingCount'||dimension==='skuHoldingCount';
  return [...templates.values()].sort((a,b)=>exact
    ? (a.key==='__unknown__'?Infinity:Number(a.key))-(b.key==='__unknown__'?Infinity:Number(b.key))
    : 0).map(template=>own.get(template.key) ?? {
      key:template.key,label:template.label,color:template.color,
      amount:0,gross:0,returns:0,quantity:0,grossQuantity:0,returnedQuantity:0,kinds:0,lots:0,records:0,skus:0,
      unknown:{amount:0,cost:0,quantity:0,category:0,kind:0,lot:0,channel:0,origin:0,date:0},
    });
}
