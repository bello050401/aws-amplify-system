'use server';
import {randomUUID,createHash} from 'node:crypto';
import {cookies} from 'next/headers';
import {uploadData} from 'aws-amplify/storage/server';
import {runWithAmplifyServerContext} from '@/lib/amplify/serverUtils';
import {canEditInventory,getInventoryRole,getCurrentInventoryUserEmail} from '@/lib/amplify/requireInventoryUser';
import {createInventory} from './inventory';
import {importedStockTitle} from '@/lib/inventory/managedStockTitle';
import {getInventoryRaw} from '@/lib/inventory/categoryPersistence';
import {listCategories,listLocations} from '@/lib/inventory/queries';
import {resolveRestageDefaults,importCustom} from '@/lib/procurement/restageLedger';
import {classifyItem} from '@/lib/procurement/restage';
import {procurementLedgerDetails} from '@/lib/procurement/ledgerDetails';
import {trefacConnection} from '@/lib/procurement/trefacHttp';
import {completeTrefacLot,trefacInventoryId,type TrefacLot} from '@/lib/procurement/trefac';
import {getImportRecord,putImportRecord,claimImport,releaseImport} from '@/lib/procurement/store';
async function actor(){if(!canEditInventory(await getInventoryRole()))throw Error('仕入れの操作権限がありません。');const who=await getCurrentInventoryUserEmail();if(!who)throw Error('ログインを確認してください。');return who;}
const safe=(e:unknown)=>e instanceof Error&&/トレファク|商品|落札|数量|在庫|取込|取得|登録|点数|写真|変更/.test(e.message)?e.message:'取込を完了できません。接続状態を確認して再試行してください。';
const receipt=(lot:TrefacLot)=>({pk:'TREFAC#'+lot.account,sk:'ITEM#'+lot.goodsId});
const matches=(row:Record<string,unknown>|undefined,lot:TrefacLot)=>!!row&&importCustom(row).__trefacImport?.goodsId===lot.goodsId&&importCustom(row).__trefacImport?.account===lot.account;
export async function fetchTrefacAction(){
 const who=await actor();try{const client=await trefacConnection(),lots=await client.fetchLots(),runId=randomUUID(),defaults=resolveRestageDefaults(...await Promise.all([listCategories(),listLocations()])),ttl=Math.floor(Date.now()/1000)+86400;const rows=[];
 for(const lot of lots){const k=receipt(lot),prior=await getImportRecord(k.pk,k.sk);if(prior?.status==='REGISTERED')continue;await putImportRecord({pk:'TF_RUN#'+runId,sk:lot.goodsId,lot,createdBy:who,ttl,defaults});rows.push(lot);}
 return{ok:true as const,runId,lots:rows};}catch(e){return{ok:false as const,error:safe(e)};}
}
export async function registerTrefacAction(runId:string,goodsId:string,pieces:number){
 const who=await actor();if(!/^[0-9a-f-]{36}$/.test(runId)||!/^\d{1,12}$/.test(goodsId))return{ok:false as const,error:'取得結果が不正です。'};
 const preview=await getImportRecord('TF_RUN#'+runId,goodsId);if(!preview||preview.createdBy!==who||preview.ttl<Date.now()/1000)return{ok:false as const,error:'取得結果の有効期限が切れました。再度取得してください。'};
 let lot:TrefacLot;try{lot=completeTrefacLot(preview.lot,pieces);}catch(e){return{ok:false as const,error:safe(e)};}
 const k=receipt(lot),prior=await getImportRecord(k.pk,k.sk);if(prior?.status==='REGISTERED')return{ok:true as const,id:String(prior.inventoryId),skipped:true};
 const owner=await claimImport(k.pk,k.sk,180);if(!owner)return{ok:false as const,error:'この商品は登録中です。再取得で結果を確認してください。'};
 const id=trefacInventoryId(lot),done=()=>releaseImport(k.pk,k.sk,owner,{status:'REGISTERED',inventoryId:id,lot,registeredAt:new Date().toISOString()});
 try{
  const existing=await getInventoryRaw(id);if(existing){if(!matches(existing,lot))throw Error('登録先の商品IDが一致しません。');await done();return{ok:true as const,id,skipped:true};}
  const client=await trefacConnection(),latest=await client.verify(lot.documentId);
  if(['account','goodsId','soldAt','hammerPrice','sourceQuantity','name','imageUrl'].some(key=>latest[key as keyof TrefacLot]!==lot[key as keyof TrefacLot]))throw Error('落札内容が変更されています。再取得してください。');
  const image=await client.image(lot.imageUrl),storageKey='inventory/'+id+image.ext;
  await runWithAmplifyServerContext({nextServerContext:{cookies},operation:context=>uploadData(context,{path:storageKey,data:image.bytes,options:{contentType:image.mime,cacheControl:'public, max-age=31536000, immutable'}}).result});
  const ledger=procurementLedgerDetails(lot.name),defaults=preview.defaults,title=importedStockTitle(lot.name,lot.quantity!,'点','TREFAC');
  await createInventory({name:title.name,quantity:lot.quantity!,unit:'点',purchasePrice:lot.purchasePrice!,purchaseQuantity:lot.quantity!,transactionDate:lot.date,transactionType:'買受',usedGoodsItemType:classifyItem(lot.name),...ledger,counterpartyName:'トレファクライブネットオークション',note:lot.description?'【仕入先記載／トレファク】\n'+lot.description:'',adminMemo:`トレファク 商品ID:${lot.goodsId} 出品番号:${lot.lotNumber}\n落札日時:${lot.soldAt}\n落札単価:${lot.hammerPrice}円／落札数量:${lot.sourceQuantity}組／1組:${lot.pieces}点\n仕入れ合計:${lot.purchaseTotal}円（落札額×1.21）\n購入単価:${lot.purchasePrice}円（点数で割り、四捨五入）`,categoryId:defaults.categoryId,categoryIds:[defaults.categoryId],locationId:defaults.locationId,customFields:{...ledger.customFields,__belloStockTitle:title.metadata,__trefacImport:{...lot,multiplier:'1.21',rounding:'HALF_UP',defaults}},images:[{kind:'uploaded',storageKey,sortOrder:0,type:'NORMAL',isPrimary:true,sourceSystem:null,sourceUrl:lot.imageUrl,thumbnailKey:null,mediumKey:null,originalHash:createHash('sha256').update(image.bytes).digest('hex'),classification:null}]},{id,skipRedirect:true});
  await done();return{ok:true as const,id,skipped:false};
 }catch(e){const existing=await getInventoryRaw(id).catch(()=>undefined);if(matches(existing,lot)){await done();return{ok:true as const,id,skipped:false};}await releaseImport(k.pk,k.sk,owner,{status:'FAILED',lastError:safe(e)});return{ok:false as const,error:safe(e)};}
}
