import {createHash} from 'node:crypto';
import type {PurchaseMail} from './mailParser';
import type {SaleCandidate,YahooSaleStatus} from './model';

const stages:YahooSaleStatus[]=['WON','ADDRESS_CONFIRMED','AWAITING_SHIPMENT'];
const missingPrice='落札価格を取得できていません。落札通知の取得後、金額を確認してください。';
const missingQuantity='落札数量はメールから確定できません。数量（セット販売の場合はセット数）を確認してください。「残り数量」は売却数量ではありません。';
const dateWarning='販売終了日は支払い完了メールの受信日（日本時間）で自動入力します。未入金の間は空欄です。';
const field=(text:string,label:string)=>text.match(new RegExp('(?:^|\\n)[ \\t]*'+label+'[ \\t]*:[ \\t]*([^\\n]+)'))?.[1]?.trim()||'';
const yen=(value:string)=>{const s=value.replace(/[¥円,\s]/g,'');return /^\d+$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):null;};
const jstDate=(value:string)=>new Date(Date.parse(value)+9*3600000).toISOString().slice(0,10);

/** Only observed seller notifications, never a bid, buyer notification or quoted body status. */
export function parseYahooMail(mail:PurchaseMail,text:string):SaleCandidate[]{
 const sender=(mail.from.match(/<([^>]+)>/)?.[1]||mail.from).trim().toLowerCase();
 if(sender!=='auction-master@mail.yahoo.co.jp')return [];
 const subject=mail.subject.normalize('NFKC').trim().replace(/^Yahoo!オークション\s*-\s*/, '');
 let stage:YahooSaleStatus;
 if(/^(?:即決価格での落札|終了\(落札者あり\)|落札)\s*:/.test(subject))stage='WON';
 else if(/^お届け先住所確定\s*:/.test(subject))stage='ADDRESS_CONFIRMED';
 else if(/^支払いが完了しました。商品を発送してください\s*:/.test(subject))stage='AWAITING_SHIPMENT';
 else return [];
 const ids=[field(text,'オークションID'),subject.match(/\(([a-z][0-9]{6,15})\)\s*$/i)?.[1],...Array.from(text.matchAll(/https:\/\/auctions\.yahoo\.co\.jp\/(?:jp\/)?auction\/([a-z][0-9]{6,15})(?=[?\s)<]|$)/gi),m=>m[1])].filter((id):id is string=>!!id).map(id=>id.toLowerCase());
 // Conflicting/missing IDs cannot be safely consolidated into a transaction.
 if(!ids.length||ids.some(id=>!(/^[a-z][0-9]{6,15}$/).test(id)||id!==ids[0]))return [];
 const id=ids[0],now=new Date().toISOString();
 const received=Number.isFinite(Date.parse(mail.receivedAt))?new Date(mail.receivedAt).toISOString():now;
 const name=(field(text,'商品')||subject.replace(/^[^:]+:\s*/, '').replace(/\([a-z][0-9]{6,15}\)\s*$/i,'').trim()).slice(0,2000);
 if(!name)return [];
 // Start price, remaining stock, shipping and payment total must never become the sale unit price.
 const price=stage==='WON'?(yen(field(text,'落札価格'))??yen(field(text,'落札金額'))):null;
 const shipping=yen(field(text,'送料'))??yen(field(text,'配送料'));
 const orderTotal=yen(field(text,'合計金額'))??yen(field(text,'支払い金額'));
 const rawCount=stage==='WON'?field(text,'落札数量'):'';
 const count=rawCount.match(/^(\d+)(?:\s*(?:個|点|台|脚|セット))?$/)?.[1];
 const quantity=count&&Number.isSafeInteger(Number(count))&&Number(count)>0?Number(count):null;
 return [{id:createHash('sha256').update(JSON.stringify(['YAHOO',id,'0'])).digest('hex'),state:'PENDING',channel:'YAHOO',source:'GMAIL',name,quantity,unitPrice:price,orderId:id,identifierType:'AUCTION',externalListingId:id,saleDate:jstDate(received),receivedAt:received,createdAt:now,updatedAt:now,shipping,orderTotal,payment:'',warnings:[...(price===null?[missingPrice]:[]),...(quantity===null?[missingQuantity]:[]),dateWarning],orderLineCount:1,yahooStatus:stage,yahooEvents:{[stage]:received},...(stage==='AWAITING_SHIPMENT'&&mail.authenticatedYahooSender&&Number.isFinite(Date.parse(mail.receivedAt))?{yahooPaymentNotice:{gmailId:mail.gmailId,receivedAt:received}}:{})}];
}

/** Merge mail-owned fields only; preserve deletion, completed sale and inventory references. */
export function mergeYahooNotification(current:SaleCandidate,incoming:SaleCandidate,now=new Date().toISOString()):SaleCandidate{
 if(current.channel!=='YAHOO'||incoming.channel!=='YAHOO'||current.id!==incoming.id||current.orderId!==incoming.orderId||!incoming.yahooStatus)throw Error('YAHOO_CANDIDATE_MISMATCH');
 if(current.state==='DELETED')return current;
 const events={...current.yahooEvents};
 for(const stage of stages){const at=incoming.yahooEvents?.[stage];if(at&&(!events[stage]||at<events[stage]!))events[stage]=at;}
 const status=stages.reduce((latest,stage)=>events[stage]||current.yahooStatus===stage?stage:latest,current.yahooStatus||incoming.yahooStatus);
 const price=current.unitPrice??incoming.unitPrice,quantity=current.quantity??incoming.quantity;
 const warnings=[...new Set([...current.warnings,...incoming.warnings])].filter(w=>!(w===missingPrice&&price!==null)&&!(w===missingQuantity&&quantity!==null));
 if(current.unitPrice!==null&&incoming.unitPrice!==null&&current.unitPrice!==incoming.unitPrice)warnings.push('同じオークションIDで異なる落札価格の通知があります。金額を確認してください。');
 if(current.quantity!==null&&incoming.quantity!==null&&current.quantity!==incoming.quantity)warnings.push('同じオークションIDで異なる落札数量の通知があります。数量を確認してください。');
 const conflicts=(['shipping','orderTotal'] as const).filter(k=>current[k]!==null&&incoming[k]!==null&&current[k]!==incoming[k]);
 if(conflicts.length)warnings.push('同じオークションIDで送料・支払い合計が異なる通知があります。取引ナビで確認してください。');
 const notice=[current.yahooPaymentNotice,incoming.yahooPaymentNotice].filter((v):v is NonNullable<SaleCandidate['yahooPaymentNotice']>=>!!v).sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt))[0];
 const next={...current,name:current.name||incoming.name,unitPrice:price,quantity,shipping:current.shipping??incoming.shipping,orderTotal:current.orderTotal??incoming.orderTotal,warnings:[...new Set(warnings)].filter(w=>!w.startsWith('販売終了日は落札通知の受信日')),externalListingId:current.externalListingId||incoming.externalListingId,yahooStatus:status,yahooEvents:events,receivedAt:[current.receivedAt,incoming.receivedAt].sort().at(-1)!,saleDate:events.WON?jstDate(events.WON):current.saleDate,...(notice?{yahooPaymentNotice:notice}:{})};
 if(JSON.stringify(next)===JSON.stringify(current))return current;
 return {...next,updatedAt:new Date(Math.max(Date.parse(now),Date.parse(current.updatedAt)+1)).toISOString()};
}
