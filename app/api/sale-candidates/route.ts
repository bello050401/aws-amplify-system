import {NextResponse} from 'next/server';
import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {candidateStore,candidateConfig} from '@/lib/saleCandidates/store';
import {candidateKey} from '@/lib/saleCandidates/mailParser';
import {registerSoldOut} from '@/app/actions/soldOut';
import {getInventoryDetail} from '@/lib/inventory/queries';
import {bodyLimited,NO_STORE} from '@/lib/invoicing/gateway';
import {japanToday} from '@/lib/inventory/soldOutInput';
import {importBaseOrders} from '@/lib/saleCandidates/baseImport';
import {reviewPostSale,executePostSale} from '@/lib/saleCandidates/postSale';
export const dynamic='force-dynamic';export const maxDuration=180;
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:NO_STORE});
export async function GET(request:Request){
 try{
  if((await inventoryMutationSession())?.role!=='ADMIN')return reply({error:'管理者のみ利用できます。'},403);
  const u=new URL(request.url),state=u.searchParams.get('state')==='DONE'?'DONE':'PENDING';
  const store=candidateStore(),[page,fees,status,baseStatus]=await Promise.all([store.list(state,u.searchParams.get('cursor')||undefined),store.config(),store.status(),store.baseStatus()]);
  const items=await Promise.all(page.items.map(async c=>{
   const id=c.state==='DONE'?c.result?.soldId:c.source==='INVOICE'&&!c.name?c.suggestedInventoryId:undefined;
   if(!id)return c;
   const item=await getInventoryDetail(id);
   return {...c,name:item?.name||c.name||'請求書の商品（在庫を再選択してください）',...(c.state==='DONE'&&item?{completedSale:{quantity:c.result!.soldQuantity,total:item.salePrice??null,commission:item.saleCommission??null,date:item.saleEndDate||'',identifier:item.externalProductId||''}}:{})};
  }));
  return reply({items,cursor:page.cursor,fees,status,baseStatus});
 }catch{return reply({error:'売却候補を取得できませんでした。'},503);}
}
export async function POST(request:Request){
 try{
  const session=await inventoryMutationSession();if(session?.role!=='ADMIN')return reply({error:'管理者のみ利用できます。'},403);
  const origin=request.headers.get('origin');
  if(request.headers.get('x-bello-sale-candidates')!=='1'||request.headers.get('sec-fetch-site')==='cross-site'||origin&&origin!==(process.env.BELLO_MOBILE_PUBLIC_ORIGIN||new URL(request.url).origin))return reply({error:'許可されていない操作です。'},403);
  const b=await bodyLimited(request),store=candidateStore();
  if(b.action==='base-import')return reply(await importBaseOrders());
  if(b.action==='import'){
   const r=await new LambdaClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:1}).send(new InvokeCommand({FunctionName:candidateConfig().functionName,Payload:Buffer.from('{}')}));
   if(r.FunctionError||!r.Payload)throw Error('IMPORT_FAILED');
   const value=JSON.parse(Buffer.from(r.Payload).toString());return reply(value,value.ok?200:409);
  }
  if(b.action==='fees'){await store.configure(b.fees,session.owner);return reply({ok:true});}
  if(b.action==='direct'){
   if(typeof b.mutationId!=='string'||! /^[0-9a-f-]{36}$/i.test(b.mutationId))return reply({error:'入力内容を確認してください。'},422);
   const now=new Date().toISOString(),id=candidateKey('DIRECT',b.mutationId,'0');
   await store.put({id,state:'PENDING',channel:'DIRECT',source:'DIRECT',name:'直接取引',quantity:1,unitPrice:null,orderId:'',identifierType:'MANUAL',saleDate:japanToday(),receivedAt:now,createdAt:now,updatedAt:now,shipping:null,orderTotal:null,payment:'',warnings:[],orderLineCount:1});
   return reply({ok:true,candidate:await store.get(id)});
  }
  if(!/^[a-f0-9]{64}$/.test(b.id))return reply({error:'対象の候補を選び直してください。'},422);
  if(b.action==='delete'){await store.remove(b.id,session.owner);return reply({ok:true});}
  if(b.action==='ec-review')return reply({ok:true,plan:await reviewPostSale(b.id,session.owner,b.packSizes)});
  if(b.action==='ec-confirm')return reply({ok:true,plan:await executePostSale(b.id,session.owner,b.token,b.confirmed===true)});
  if(b.action==='confirm'){
   const candidate=await store.get(b.id);if(!candidate||candidate.state==='DELETED')return reply({error:'この候補は削除されています。'},409);
   const result=await registerSoldOut({...b.sale,sourceCandidateId:b.id});
   return reply(result,result.ok?200:result.code==='FORBIDDEN'?403:result.code==='INVALID'?422:409);
  }
  return reply({error:'操作を確認してください。'},422);
 }catch(e){return reply({error:(e as Error).name==='ConditionalCheckFailedException'?'別の操作で状態が変わりました。再読み込みしてください。':'処理結果を確認できませんでした。再読み込みして確認してください。'},503);}
}
