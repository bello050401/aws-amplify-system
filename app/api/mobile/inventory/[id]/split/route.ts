import {NextResponse} from 'next/server';
import {revalidatePath} from 'next/cache';
import {getMobileSession} from '@/lib/mobile/session';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {createStockSplitService} from '@/lib/inventory/stockSplitCore';
import {StockSplitError} from '@/lib/inventory/stockSplitInput';
import {copySoldOutPhotos,discardSoldOutPhotos} from '@/lib/inventory/soldOutPhotos';
import {serverDataClient,inventoryAuthMode} from '@/lib/amplify/dataClient';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params: Promise<{id:string}>}){
 const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
 const fail=(error:string,status:number,code='INVALID')=>NextResponse.json({ok:false,error,code},{status,headers});
 const session=await getMobileSession();
 if(!session.ok)return fail(session.error,session.status,'FORBIDDEN');
 const verified=await inventoryMutationSession();
 if(!verified||verified.owner!==session.owner||session.role==='VIEWER'||process.env.BELLO_MOBILE_WRITES_ENABLED!=='true')return fail('在庫を分ける権限がありません。',403,'FORBIDDEN');
 const origin=request.headers.get('origin');
 if(request.headers.get('x-bello-mobile')!=='1'||request.headers.get('sec-fetch-site')==='cross-site'||(origin&&origin!==(process.env.BELLO_MOBILE_PUBLIC_ORIGIN||new URL(request.url).origin)))return fail('許可されていない操作です。',403,'FORBIDDEN');
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return fail('入力内容を確認してください。',415);
 let input;
 try{
  const reader=request.body?.getReader();if(!reader)return fail('入力内容を確認してください。',400);
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536){await reader.cancel();return fail('入力内容が長すぎます。',413);}chunks.push(next.value);}}finally{reader.releaseLock();}
  input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }catch{return fail('入力内容を確認してください。',400);}
 if(input?.inventoryId!==(await context.params).id)return fail('商品を確認してください。',422);
 try{
  const execute=createStockSplitService({db:inventoryDdb,table:inventoryTable,copyPhotos:copySoldOutPhotos,discardPhotos:discardSoldOutPhotos,nextSku:async()=>{
   const result=await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);if(!result.data||result.errors?.length)throw Error('管理番号を作成できませんでした。');return result.data;
  }});
  const result=await execute(input,session.owner);clearInventoryCountCache();
  revalidatePath('/inventory');revalidatePath('/inventory/'+result.sourceId);revalidatePath('/inventory/'+result.splitId);
  return NextResponse.json({ok:true,owner:session.owner,mutationId:input.mutationId,result},{headers});
 }catch(error){
  if(error instanceof StockSplitError)return fail(error.message,error.code==='CONFLICT'?409:error.code==='INVALID'?422:503,error.code);
  console.error('[stock-split]',error instanceof Error?error.name:'UnknownError');
  return fail('保存結果を確認できません。同じ内容で結果を再確認してください。',503,'UNCONFIRMED');
 }
}
