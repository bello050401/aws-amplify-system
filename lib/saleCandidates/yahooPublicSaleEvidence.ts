import {parse,type DefaultTreeAdapterMap} from 'parse5';
export type YahooPublicSaleEvidence={kind:'PUBLIC_LISTING';auctionId:string;title:string;priceYen:number;quantity:number;status:'open'|'closed'|'cancelled';bids:number;bidders:number;highestBidders:number;checkedAt:string};
const MAX_HTML_BYTES=2*1024*1024;
const validId=(id:string)=>/^[a-z][0-9]{8,12}$/.test(id);
/** Public read proof has no seller privileges and can never authorize a write. */
export function parseYahooPublicSaleEvidence(html:string,auctionId:string,now=Date.now()):YahooPublicSaleEvidence|null{
 if(!validId(auctionId)||Buffer.byteLength(html)>MAX_HTML_BYTES)return null;
 try{
  const pending:DefaultTreeAdapterMap['node'][]=[parse(html)],scripts:string[]=[];let count=0;
  while(pending.length){const n=pending.pop()!;if(++count>30000)return null;if('tagName'in n&&n.tagName==='script'&&n.attrs.some(a=>a.name==='id'&&a.value==='__NEXT_DATA__'))scripts.push(n.childNodes.map(c=>'value'in c?c.value:'').join(''));if('childNodes'in n)pending.push(...n.childNodes);}
  if(scripts.length!==1)return null;
  const d=JSON.parse(scripts[0]).props.pageProps.initialState.item.detail.item;
  if(d.auctionId!==auctionId||typeof d.title!=='string'||!d.title.trim()||[...d.title].length>2000||!Number.isSafeInteger(d.price)||d.price<1||!Number.isSafeInteger(d.quantity)||d.quantity<1||d.quantity>9||!['open','closed','cancelled'].includes(d.status)||![d.bids,d.biddersNum,d.highestBidders?.totalHighestBidders].every(n=>Number.isSafeInteger(n)&&n>=0))return null;
  return {kind:'PUBLIC_LISTING',auctionId,title:d.title,priceYen:d.price,quantity:d.quantity,status:d.status,bids:d.bids,bidders:d.biddersNum,highestBidders:d.highestBidders.totalHighestBidders,checkedAt:new Date(now).toISOString()};
 }catch{return null;}
}
/** Fixed anonymous GET only. Redirects, cookies, retries and challenge workarounds are prohibited. */
export async function readYahooPublicSaleEvidence(auctionId:string,options:{fetchImpl?:typeof fetch;now?:()=>number}={}):Promise<YahooPublicSaleEvidence>{
 if(!validId(auctionId))throw Error('YAHOO_SALE_FORM_CHANGED');
 const request=options.fetchImpl??fetch;let response:Response;
 try{response=await request('https://auctions.yahoo.co.jp/jp/auction/'+auctionId,{method:'GET',headers:{Accept:'text/html'},redirect:'manual',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(15000)});}catch{throw Error('YAHOO_SALE_READ_UNAVAILABLE');}
 if(response.status!==200||response.redirected||(response.headers.get('content-type')??'').split(';',1)[0].trim().toLowerCase()!=='text/html'){
  await response.body?.cancel().catch(()=>{});throw Error(response.status===403?'YAHOO_SALE_ACCESS_DENIED':response.status===429?'YAHOO_SALE_RATE_LIMITED':'YAHOO_SALE_READ_UNAVAILABLE');
 }
 const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_HTML_BYTES)){await response.body?.cancel().catch(()=>{});throw Error('YAHOO_SALE_FORM_CHANGED');}
 const reader=response.body?.getReader();if(!reader)throw Error('YAHOO_SALE_FORM_CHANGED');
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>MAX_HTML_BYTES){await reader.cancel().catch(()=>{});throw Error('YAHOO_SALE_FORM_CHANGED');}chunks.push(chunk.value);}}catch(e){if((e as Error).message==='YAHOO_SALE_FORM_CHANGED')throw e;throw Error('YAHOO_SALE_READ_UNAVAILABLE');}
 const html=Buffer.concat(chunks).toString('utf8'),proof=parseYahooPublicSaleEvidence(html,auctionId,options.now?.()??Date.now());
 if(!proof)throw Error('YAHOO_SALE_FORM_CHANGED');return proof;
}
