'use server';
import {randomUUID,createHash} from 'node:crypto';
import {cookies} from 'next/headers';
import {uploadData} from 'aws-amplify/storage/server';
import {runWithAmplifyServerContext} from '@/lib/amplify/serverUtils';
import {canEditInventory,getInventoryRole,getCurrentInventoryUserEmail} from '@/lib/amplify/requireInventoryUser';
import {createInventory} from './inventory';
import {getInventoryRaw,persistInventoryWithCategories} from '@/lib/inventory/categoryPersistence';
import {listCategories,listLocations} from '@/lib/inventory/queries';
import {withHumanEdits} from '@/lib/inventory/humanEdits';
import {logInventoryHistory,diffField} from '@/lib/inventory/history';
import {revalidatePath} from 'next/cache';
import {restageLedger,ledgerFields,resolveRestageDefaults,restageSupplement,importCustom,type RestageLedger,type RestageDefaults} from '@/lib/procurement/restageLedger';
import {assertAuctionDate,restageInventoryFields,type RestageLot} from '@/lib/procurement/restage';
import {claimImport,releaseImport,releaseFetchLock,getImportRecord,putImportRecord,importRecordsForDate,restageInventoryId,restageConnection,resetRestageConnection} from '@/lib/procurement/store';

async function authorize(){if(!canEditInventory(await getInventoryRole()))throw Error('定期仕入れの操作権限がありません。');}
const safeError=(e:unknown)=>e instanceof Error&&/リステージ|落札|開催|一山|写真|登録|確認|取得|商品|接続|定期仕入れ/.test(e.message)?e.message:'取得に失敗しました。再度お試しください。';
function matchesSource(row:Record<string,unknown>|undefined,lot:RestageLot){if(!row)return false;try{const fields=typeof row.customFields==='string'?JSON.parse(row.customFields):row.customFields;return fields?.__restageImport?.date===lot.date&&fields.__restageImport.goodsId===lot.goodsId;}catch{return false;}}

export async function fetchRestageAction(date:string){
  await authorize();assertAuctionDate(date);
  const lease=await claimImport('LOCK','RESTAGE',120);if(!lease)return{ok:false as const,error:'別の画面で取得中です。少し待ってからお試しください。'};
  try{
    const connection=await restageConnection(),fetched=await connection.fetchLots(date),runId=randomUUID(),who=await getCurrentInventoryUserEmail(),ttl=Math.floor(Date.now()/1000)+86400;
    const previous=await importRecordsForDate(date),registered=new Map(previous.filter(x=>x.status==='REGISTERED').map(x=>[String(x.goodsId),String(x.inventoryId)]));
    const [categories,locations]=await Promise.all([listCategories(),listLocations()]);
    const defaults=resolveRestageDefaults(categories,locations),ledger=fetched.lots.length&&!fetched.errors.length?restageLedger(fetched.lots):null;
    for(const lot of fetched.lots)await putImportRecord({pk:'RUN#'+runId,sk:'LOT#'+lot.goodsId,lot,ledger,defaults,createdBy:who,createdAt:new Date().toISOString(),ttl});
    const lots=await Promise.all(fetched.lots.map(async lot=>{const inventoryId=registered.get(lot.goodsId)??null,row=inventoryId?await getInventoryRaw(inventoryId):undefined;let needsUpdate=false;
      if(row&&ledger){try{needsUpdate=Object.keys(restageSupplement(row,lot,ledger,defaults)).length>0;}catch{needsUpdate=true;}}
      return {...lot,inventoryId,needsUpdate,deleted:!!inventoryId&&!row};}));
    return {ok:true as const,runId,lots,ledger,errors:fetched.errors};
  }catch(e){resetRestageConnection();return{ok:false as const,error:safeError(e)};}
  finally{await releaseFetchLock(lease);}
}

export async function registerRestageLotAction(runId:string,goodsId:string){
  await authorize();
  if(!/^[0-9a-f-]{36}$/.test(runId)||!/^\d{1,12}$/.test(goodsId))return{ok:false as const,error:'取得結果が不正です。再度取得してください。'};
  const preview=await getImportRecord('RUN#'+runId,'LOT#'+goodsId);
  if(!preview||Number(preview.ttl)<Date.now()/1000)return{ok:false as const,error:'取得結果の有効期限が切れました。再度取得してください。'};
  const lot=preview.lot as RestageLot,ledger=preview.ledger as RestageLedger|null,defaults=preview.defaults as RestageDefaults;
  if(!ledger||ledger.date!==lot.date||ledger.version!==2||!defaults)return{ok:false as const,error:'全落札の台帳集計を確認できません。取得エラーを解消して再取得してください。'};
  const pk='DATE#'+lot.date,sk='LOT#'+lot.goodsId,id=restageInventoryId(lot);
  const previous=await getImportRecord(pk,sk);
  if(previous?.status==='REGISTERED'){
    const inventoryId=String(previous.inventoryId),repairPk='LEDGER#'+lot.date,owner=await claimImport(repairPk,sk);
    if(!owner)return{ok:false as const,error:'この商品の台帳を更新中です。少し待って再取得してください。'};
    try{
      const existing=await getInventoryRaw(inventoryId);
      if(!existing)return{ok:true as const,id:inventoryId,skipped:true};
      const changes=restageSupplement(existing,lot,ledger,defaults);
      if(!Object.keys(changes).length)return{ok:true as const,id:inventoryId,skipped:true};
      const who=await getCurrentInventoryUserEmail(),now=new Date().toISOString();
      const custom=changes.customFields as Record<string,unknown>|undefined;
      const revision={...changes,customFields:JSON.stringify(withHumanEdits(existing,changes,importCustom(existing),custom??importCustom(existing))),updatedBy:who??'リステージ取込',listUpdatedAt:now};
      await persistInventoryWithCategories({id:inventoryId,...revision},String(existing.updatedAt));
      await logInventoryHistory(inventoryId,who,[...Object.entries(changes).filter(([key])=>key!=='customFields').map(([key,value])=>diffField('リステージ取込：'+key,existing[key]==null?null:String(existing[key]),Array.isArray(value)?value.join(' / '):String(value)))].filter((v):v is NonNullable<typeof v>=>v!==null));
      revalidatePath('/inventory');revalidatePath('/inventory/'+inventoryId);
      return{ok:true as const,id:inventoryId,skipped:true,updated:true};
    }catch(e){return{ok:false as const,error:safeError(e)};}finally{await releaseImport(repairPk,sk,owner);}
  }
  const lease=await claimImport(pk,sk);if(!lease)return{ok:false as const,error:'この商品は登録処理中です。再取得で結果を確認できます。'};
  const complete=()=>releaseImport(pk,sk,lease,{status:'REGISTERED',goodsId,inventoryId:id,lot,registeredAt:new Date().toISOString()});
  try{
    const existing=await getInventoryRaw(id);
    if(existing){if(!matchesSource(existing,lot))throw Error('登録先の商品が一致しません。確認してください。');await complete();return{ok:true as const,id,skipped:true};}
    const connection=await restageConnection(),image=await connection.image(lot);
    const ext=image.mime==='image/png'?'.png':image.mime==='image/webp'?'.webp':'.jpg',storageKey='inventory/'+id+ext;
    await runWithAmplifyServerContext({nextServerContext:{cookies},operation:context=>uploadData(context,{path:storageKey,data:image.bytes,options:{contentType:image.mime,cacheControl:'public, max-age=31536000, immutable'}}).result});
    await createInventory({...restageInventoryFields(lot),...ledgerFields(ledger),categoryId:defaults.categoryId,categoryIds:[defaults.categoryId],locationId:defaults.locationId,customFields:{__restageImport:{date:lot.date,goodsId:lot.goodsId,hammerPrice:lot.hammerPrice,quantity:lot.quantity,multiplier:'1.188',rounding:'CEILING',isBundle:lot.isBundle,ledger}},images:[{kind:'uploaded',storageKey,sortOrder:0,type:'NORMAL',isPrimary:true,sourceSystem:null,sourceUrl:lot.imageUrl,thumbnailKey:null,mediumKey:null,originalHash:createHash('sha256').update(image.bytes).digest('hex'),classification:null}]},{skipRedirect:true,id});
    await complete();return{ok:true as const,id,skipped:false};
  }catch(e){
    // A response may be lost after the inventory transaction committed. Never
    // remove its image or create a different ID when retrying.
    const existing=await getInventoryRaw(id).catch(()=>undefined);
    if(matchesSource(existing,lot)){await complete();return{ok:true as const,id,skipped:false};}
    resetRestageConnection();await releaseImport(pk,sk,lease,{status:'FAILED',goodsId,lastError:safeError(e),failedAt:new Date().toISOString()});
    return{ok:false as const,error:safeError(e)};
  }
}
