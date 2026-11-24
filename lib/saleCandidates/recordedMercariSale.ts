import {ScanCommand,type ScanCommandInput} from '@aws-sdk/lib-dynamodb';
import type {SaleCandidate} from './model';

export const MERCARI_RECORDED_SALE_REASON='MERCARI_ORDER_ALREADY_RECORDED';
type Row=Record<string,unknown>;
/** A legacy manual sale can lack quantity/split metadata. Exact order + channel + sale date still blocks replay. */
export function recordedMercariOrders(rows:readonly Row[]):Set<string> {
 return new Set(rows.flatMap(row=>typeof row.id==='string'&&row.market==='メルカリSHOP'&&typeof row.externalProductId==='string'&&row.externalProductId.length>0&&typeof row.saleEndDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.saleEndDate)&&Number.isFinite(Date.parse(row.saleEndDate))&&new Date(row.saleEndDate).toISOString().slice(0,10)===row.saleEndDate?[row.externalProductId]:[]));
}
export function hasRecordedMercariSale(c:Pick<SaleCandidate,'channel'|'orderId'|'state'>,orders:ReadonlySet<string>):boolean {
 return c.state==='PENDING'&&c.channel==='MERCARI'&&!!c.orderId&&orders.has(c.orderId);
}
type Reader={send:(command:ScanCommand)=>Promise<{Items?:Row[];LastEvaluatedKey?:Record<string,unknown>}>};
/** One shared initial snapshot and one shared pre-mutation snapshot per worker invocation.
 * No title/quantity inference, per-candidate scans, truncated success, or negative process-global cache.
 * The schema has no order index; use the authoritative table with a minimal projection.
 */
export function createRecordedMercariSaleGuard(db:Reader,table:string) {
 const read=async()=>{
  const rows:Row[]=[];let key:ScanCommandInput['ExclusiveStartKey'];
  for(let page=0;page<30;page++){
   const result=await db.send(new ScanCommand({TableName:table,ConsistentRead:true,Limit:1000,ExclusiveStartKey:key,ProjectionExpression:'id,market,externalProductId,saleEndDate',FilterExpression:'market=:market AND attribute_exists(saleEndDate)',ExpressionAttributeValues:{':market':'メルカリSHOP'}}));
   rows.push(...result.Items??[]);if(rows.length>30000)throw Error('MERCARI_RECORDED_SALE_CHECK_UNAVAILABLE');
   key=result.LastEvaluatedKey;if(!key)return recordedMercariOrders(rows);
  }
  throw Error('MERCARI_RECORDED_SALE_CHECK_UNAVAILABLE');
 };
 let initial:Promise<Set<string>>|undefined,preMutation:Promise<Set<string>>|undefined;
 return async(c:Pick<SaleCandidate,'channel'|'orderId'|'state'>,beforeMutation=false):Promise<boolean>=>{
  if(c.channel!=='MERCARI'||c.state!=='PENDING'||!c.orderId)return false;
  try{
   const orders=await (beforeMutation?(preMutation??=read()):(initial??=read()));
   return hasRecordedMercariSale(c,orders);
  }catch{throw Error('MERCARI_RECORDED_SALE_CHECK_UNAVAILABLE');}
 };
}
