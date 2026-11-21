import type {PurchaseMail} from './mailParser';
import type {SaleCandidate} from './model';

/** Notification mail links to the seller order, not necessarily the product.
 * Preserve this distinction: a desktop must read the actual order/photo before
 * resolving an inventory record or external listing. */
export function mercariOrderIdentity(mail:PurchaseMail,orderId:string):{mercariOrderUrl:string;mercariShopId:string}|null {
 if(!mail.authenticatedMercariSender||!/^order_[A-Za-z0-9]{10,64}$/.test(orderId))return null;
 const urls=new Set<string>();
 for(const source of [mail.text||'',mail.html||''])for(const match of source.matchAll(/https:\/\/[^\s<>"']+/g)){
  try{
   const url=new URL(match[0].replace(/&amp;/g,'&'));
   if(url.protocol!=='https:'||url.hostname!=='mercari-shops.com'||url.username||url.password||url.port)continue;
   const parts=url.pathname.match(/^\/seller\/shops\/([A-Za-z0-9]{10,64})\/orders\/([A-Za-z0-9]{10,64})\/?$/);
   if(!parts)continue;
   // Multiple distinct order links, even to different shops, are ambiguous.
   urls.add(`https://mercari-shops.com/seller/shops/${parts[1]}/orders/${parts[2]}`);
  }catch{/* Untrusted malformed URLs are not instructions or identities. */}
 }
 if(urls.size!==1)return null;
 const mercariOrderUrl=[...urls][0],parts=mercariOrderUrl.split('/');
 if('order_'+parts[parts.length-1]!==orderId)return null;
 return {mercariOrderUrl,mercariShopId:parts[5]};
}

/** Enrich old pending notifications without changing their idempotency key or
 * overwriting a sale/deletion. The store applies a state+version CAS. */
export function mergeMercariNotification(current:SaleCandidate,incoming:SaleCandidate):SaleCandidate {
 if(current.state!=='PENDING'||current.result||current.channel!=='MERCARI'||incoming.channel!=='MERCARI'||incoming.source!=='GMAIL'||incoming.senderAuthenticated!==true||current.id!==incoming.id||current.orderId!==incoming.orderId)return current;
 if(current.senderAuthenticated){
  if(current.name!==incoming.name||current.quantity!==incoming.quantity||current.unitPrice!==incoming.unitPrice||current.shipping!==incoming.shipping||current.orderTotal!==incoming.orderTotal)return current;
  if(current.mercariOrderUrl&&current.mercariOrderUrl!==incoming.mercariOrderUrl)return current;
 }
 const next={...current,...(!current.senderAuthenticated?{name:incoming.name,quantity:incoming.quantity,unitPrice:incoming.unitPrice,shipping:incoming.shipping,orderTotal:incoming.orderTotal,warnings:incoming.warnings}:{}),senderAuthenticated:true,
  ...(incoming.mercariOrderUrl?{mercariOrderUrl:incoming.mercariOrderUrl,mercariShopId:incoming.mercariShopId}:{})};
 if(JSON.stringify(next)===JSON.stringify(current))return current;
 return {...next,updatedAt:new Date(Math.max(Date.now(),Date.parse(current.updatedAt)+1)).toISOString()};
}
