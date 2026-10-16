/** One-shot cancellation of the explicitly approved B005105 public test.
 * Endpoints and hasCancelFee:false were observed in Yahoo's served client.
 * No redirects, automatic retry, bid cancellation or fee acceptance. */
import fs from 'node:fs/promises';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { YahooWebSession } from '../lib/listing/yahooAuction/webHttpSession';
const origin='https://auctions.yahoo.co.jp';
const id='f1248612637';
const title='THONET トーネット アームチェア ダイニングチェア 1脚';
const directory='C:/Users/win/Documents/Codex/2026-10-16/yahoo-http-proof';
async function main() {
  if(process.env.BELLO_YAHOO_AUTHORIZED_TEST!=='B005105_99999_1')throw Error();
  const publish=JSON.parse(await fs.readFile(directory+'/publication-b005105-once.json','utf8'));
  if(publish.result.evidence.candidateAuctionIds.length!==1 || publish.result.evidence.candidateAuctionIds[0]!==id ||
      !Number.isFinite(Date.parse(publish.sentAt)) || Date.now()-Date.parse(publish.sentAt)<30_000)throw Error();
  const har=JSON.parse(await fs.readFile('C:/Users/win/Desktop/auctions.yahoo.co.jp.har','utf8'));
  if(!YahooWebSession.fromHar(har).ok)throw Error();
  const entries=har.log.entries.filter((e:any)=>e.request?.method==='GET' && e.response?.status===200 &&
    e.request.url===origin+'/jp/show/submit?category=0').sort((a:any,b:any)=>Date.parse(b.startedDateTime)-Date.parse(a.startedDateTime));
  const cookie=entries[0].request.headers.find((h:any)=>h.name.toLowerCase()==='cookie').value;
  const read=async(url:string)=>{
    const r=await fetch(url,{headers:{Cookie:cookie,Accept:'application/json,text/html',Referer:origin+'/jp/auction/'+id},redirect:'manual',signal:AbortSignal.timeout(20_000)});
    if(r.status!==200 || r.redirected)throw Error();
    const t=await r.text();if(Buffer.byteLength(t)>2*1024*1024)throw Error();return {r,t};
  };
  const listing=async()=>{
    const {t}=await read(origin+'/jp/auction/'+id);
    const walk=(n:DefaultTreeAdapterMap['node']):DefaultTreeAdapterMap['node'][]=>[n,...('childNodes' in n?n.childNodes.flatMap(walk):[])];
    const scripts=walk(parse(t)).filter(n=>'tagName'in n && n.tagName==='script' && n.attrs.some(a=>a.name==='id'&&a.value==='__NEXT_DATA__'));
    if(scripts.length!==1 || !('childNodes'in scripts[0]))throw Error();
    const text=scripts[0].childNodes.map(n=>'value'in n?n.value:'').join('');
    const d=JSON.parse(text).props.pageProps.initialState.item.detail.item;
    if(d.auctionId!==id || d.title!==title || d.price!==99999 || d.quantity!==1 || !d.amISellerInfo ||
      d.bids!==0 || d.biddersNum!==0 || d.highestBidders.totalHighestBidders!==0)throw Error();
    return {status:d.status,bids:d.bids,quantity:d.quantity,priceYen:d.price};
  };
  const before=await listing();if(before.status!=='open')throw Error();
  const {r,t}=await read(origin+'/api/sell/v1/items/'+id+'/close/preview?operation=CANCEL');
  const preview=JSON.parse(t),token=r.headers.get('x-csrf-token');
  if(preview.auctionId!==id || preview.title!==title || preview.categoryInfo?.isSubmitFeeCategory!==false ||
     !preview.feeInfo || Object.keys(preview.feeInfo).some(k=>k!=='fee') ||
     (preview.feeInfo.fee!==undefined&&preview.feeInfo.fee!==0) || !token || /[\r\n]/.test(token))throw Error();
  // Recheck bids after the fee preview. The server also gets hasCancelFee:false,
  // which rejects a late bid/fee instead of implicitly accepting that charge.
  if((await listing()).status!=='open')throw Error();
  const output=await fs.open(directory+'/cancellation-f1248612637-once.json','wx',0o600);
  const record={execution:'LOCAL_NODE',transport:'HTTPS',auctionId:id,inventoryId:publish.inventoryId,
    publicationSentAt:publish.sentAt,startedAt:new Date().toISOString(),bids:0,hasCancelFee:false};
  const save=async(data:unknown)=>{const b=Buffer.from(JSON.stringify(data,null,2)+'\n');await output.write(b,0,b.length,0);await output.truncate(b.length);await output.sync();};
  try {
    await save({...record,state:'SEND_RESERVED'});
    let result:object;
    try {
      const response=await fetch(origin+'/api/sell/v1/items/'+id+'/close',{method:'PUT',
        headers:{Cookie:cookie,Origin:origin,Referer:origin+'/jp/auction/'+id,'Content-Type':'application/json',Accept:'application/json','x-csrf-token':token},
        body:JSON.stringify({hasCancelFee:false,operation:'CANCEL'}),redirect:'manual',signal:AbortSignal.timeout(20_000)});
      const text=await response.text();if(Buffer.byteLength(text)>100_000)throw Error();
      const data=text?JSON.parse(text):{};
      const after=await listing();
      result={httpStatus:response.status,responseKeys:Object.keys(data),readback:after,
        code:response.status===200&&after.status==='cancelled'?'CANCELLED_VERIFIED':'RESULT_UNKNOWN'};
    }catch {result={code:'RESULT_UNKNOWN'};}
    await save({...record,completedAt:new Date().toISOString(),result});console.log(JSON.stringify(result));
  }finally{await output.close();}
}
main().catch(()=>{console.log(JSON.stringify({code:'CANCEL_NOT_COMPLETED_CHECK_LOCAL_RESULT'}));process.exitCode=1});
