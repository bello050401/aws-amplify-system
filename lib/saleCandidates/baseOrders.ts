import {candidateKey} from './mailParser';
import {allocateFee,type SaleCandidate} from './model';

const integer=(value:unknown)=>{const n=Number(value);if(value==null||value===''||!Number.isSafeInteger(n)||n<0)throw Error('BASE_ORDER_FORMAT');return n;};
const record=(v:unknown):Record<string,unknown> => v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Project the official response immediately: buyer details never enter storage or logs. */
export function parseBaseOrder(payload:unknown,now=new Date().toISOString()):SaleCandidate[]{
 const o=record(record(payload).order);
 if(!o||typeof o.unique_key!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(o.unique_key)||!Array.isArray(o.order_items))throw Error('BASE_ORDER_FORMAT');
 if(o.cancelled!=null&&o.cancelled!==false&&Number(o.cancelled)>0||o.dispatch_status==='cancelled')return [];
 const lines=o.order_items.map(record).filter(x=>!['cancelled','canceled'].includes(String(x.status).toLowerCase()));
 if(!lines.length||lines.length>90)return [];
 const ordered=integer(o.ordered),date=new Date(ordered*1000);if(!Number.isFinite(date.getTime()))throw Error('BASE_ORDER_FORMAT');
 const route=o.fee_type==='base'?'WEB':o.fee_type==='payid_app'?'PAY_ID_APP':'UNKNOWN';
 const adjusted=Object.entries(o).some(([k,v])=>/discount|coupon|coin/i.test(k)&&v!=null&&v!==0&&v!=='0');
 const amounts=lines.map(x=>integer(x.price)*integer(x.amount));
 const transactions=Object.entries(o).filter(([k])=>k.endsWith('_payment_transaction')&&!k.startsWith('order_group_')).map(([,v])=>record(v)).filter(v=>v.collected_fee!=null);
 const feeParts=[record(o.order_charge),...transactions,...(Array.isArray(o.additional_charges)?o.additional_charges.map(record):[])].filter(v=>v&&v.collected_fee!=null);
 // A partial charge response is not a confirmed total. Partner-order charges need manual review.
 const fee=record(o.order_charge).collected_fee!=null&&transactions.length===1&&!o.sales_partner_order_brand_charges?feeParts.reduce((sum,v)=>sum+integer(v.collected_fee),0):null;
 const allocations=fee!==null&&amounts.some((n:number)=>n>0)?allocateFee(fee,amounts):null;
 const orderId=o.unique_key;
 return lines.map((x,i)=>{
  const quantity=integer(x.amount),unitPrice=integer(x.price),id=String(x.item_id),lineId=String(x.order_item_id);
  if(quantity<1||!/^[1-9][0-9]*$/.test(id)||!/^[1-9][0-9]*$/.test(lineId)||typeof x.title!=='string')throw Error('BASE_ORDER_FORMAT');
  return {id:candidateKey('BASE',orderId,'api:'+lineId),state:'PENDING',channel:'BASE',source:'BASE_API',name:x.title.slice(0,2000),quantity,unitPrice,orderId,identifierType:'ORDER',saleDate:new Date(date.getTime()+9*3600000).toISOString().slice(0,10),receivedAt:date.toISOString(),createdAt:now,updatedAt:now,shipping:integer(o.shipping_fee),orderTotal:integer(o.total),payment:String(o.payment??'').slice(0,80),warnings:[...(route==='UNKNOWN'?['注文経路を判別できません。確認してください。']:[]),...(x.variation_id?['種類・バリエーションも確認してください。']:[]),...(adjusted||integer(o.total)!==amounts.reduce((a:number,b:number)=>a+b,0)+integer(o.shipping_fee)?['注文に割引等の差額があります。販売単価と手数料を確認してください。']:[])],orderLineCount:lines.length,externalListingId:id,orderLineId:lineId,orderRoute:route,feeAllocation:{index:i,amounts},...(allocations?{confirmedLineFee:allocations[i]}:{})};
 });
}
