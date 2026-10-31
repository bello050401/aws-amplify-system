import {candidateKey} from './identity';
export {candidateKey} from './identity';
import type {SaleCandidate,SaleChannel} from './model';
import {parseYahooMail} from './yahooMail';
export type PurchaseMail={gmailId:string;from:string;subject:string;receivedAt:string;text?:string;html?:string;authenticatedYahooSender?:boolean};
export const PURCHASE_QUERY_VERSION=3;
export const PURCHASE_QUERY='newer_than:7d {(from:noreply@thebase.in subject:商品購入通知) (from:no-reply@mercari-shops.com subject:発送をお願いします) (from:auction-master@mail.yahoo.co.jp {subject:落札 subject:お届け先住所確定 subject:商品を発送してください})}';
export function mailText(mail:PurchaseMail){
 return (mail.text?.trim()||mail.html?.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<br\s*\/?\s*>|<\/(?:p|div|tr|li|td)>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))||'').replace(/\r/g,'').normalize('NFKC');
}
function field(text:string,label:string){return text.match(new RegExp('(?:^|\\n)[ \\t]*'+label+'[ \\t]*[:：][ \\t]*([^\\n]+)'))?.[1]?.trim()??'';}
function yen(value:string){if(!value)return null;const s=value.replace(/[¥￥円,\s]/g,'');return /^\d+$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):null;}
export function parsePurchaseMail(mail:PurchaseMail):SaleCandidate[]{
 const sender=(mail.from.match(/<([^>]+)>/)?.[1]||mail.from).trim().toLowerCase();
 const text=mailText(mail);
 if(sender==='auction-master@mail.yahoo.co.jp')return parseYahooMail(mail,text);
 let channel:SaleChannel;
 if(sender==='noreply@thebase.in'&&/^商品購入通知[:：].*商品が購入されました/.test(mail.subject)&&/ご注文内容/.test(text))channel='BASE';
 else if(sender==='no-reply@mercari-shops.com'&&/^【メルカリShops】「.+」の発送をお願いします/.test(mail.subject)&&/商品の発送をお願いします/.test(text))channel='MERCARI';
 else return [];
 const orderId=field(text,channel==='BASE'?'注文ID':'注文番号');
 // Missing IDs stay reviewable, using the immutable message ID, without inventing an order.
 const lines=[...text.matchAll(/(?:^|\n)[ \t]*商品名[ \t]*[:：][ \t]*([^\n]+)([\s\S]*?)(?=\n[ \t]*商品名[ \t]*[:：]|$)/g)];
 const now=new Date().toISOString(),received=Number.isFinite(Date.parse(mail.receivedAt))?mail.receivedAt:now;
 const payment=text.match(/決済方法\s*[=\s]*\n([^=\n][^\n]*)/)?.[1]?.trim()||'';
 const results:SaleCandidate[]=lines.map((m,index)=>{
  // Only product/order fields cross the parser boundary. Never retain buyer, address, body or subject.
  const section=m[2].split(/配送先|お届け先|ご請求先|備考/)[0];
  const name=m[1].trim().slice(0,2000),price=yen(field(section,channel==='BASE'?'価格':'商品価格'));
  const count=field(section,channel==='BASE'?'個数':'数量').match(/^(\d+)(?:個|点)?$/)?.[1];
  const quantity=count&&Number.isSafeInteger(Number(count))&&Number(count)>0?Number(count):null;
  const warnings:string[]=[];if(!orderId)warnings.push('注文IDを取得できませんでした。');if(price===null)warnings.push('商品単価を入力してください。');if(quantity===null)warnings.push('数量を確認してください。');
  if(lines.length>1)warnings.push('複数商品の注文です。注文全体の手数料を明細へ配分して確認してください。');
  if(/クーポン|割引/.test(section)&&!/(?:クーポン割引|割引)[^\n]*[-¥￥ ]0(?:円|\s|$)/.test(section))warnings.push('割引後の金額を確認してください。');
  return {id:candidateKey(channel,orderId||'mail:'+mail.gmailId,String(index)),channel,source:'GMAIL',state:'PENDING',name,quantity,unitPrice:price,orderId:orderId.slice(0,256),identifierType:'ORDER',saleDate:new Date(Date.parse(received)+9*3600000).toISOString().slice(0,10),receivedAt:received,createdAt:now,updatedAt:now,shipping:yen(field(text,'送料')),orderTotal:yen(field(text,'合計金額')),payment:payment.slice(0,80),warnings,orderLineCount:lines.length};
 });
 const amounts=results.map(c=>c.quantity!==null&&c.unitPrice!==null?c.quantity*c.unitPrice:NaN);
 if(channel==='BASE'&&amounts.length>1&&amounts.every(n=>Number.isSafeInteger(n)&&n>=0)&&amounts.some(n=>n>0))results.forEach((c,index)=>{c.feeAllocation={index,amounts};});
 results.forEach(c=>c.warnings.push('販売終了日は通知受信日を初期表示しています。実際の販売日をご確認ください。'));
 return results;
}
