import {writeFileSync} from 'node:fs';
import {getInventoryRaw} from '../../lib/inventory/categoryPersistence';
import {readManualSync,refreshManualSync,linkExternalProduct,productFingerprint} from '../../lib/listing/econveni/manualSync';
import {selectManualLink} from '../../lib/listing/econveni/manualSyncModel';
import {readEconveniCatalog} from '../../lib/listing/econveni/runtimeStore';
async function main(){
 const plan=[{productId:'10142544',inventoryId:'3745ca7b-20b6-4c44-a4ed-8c4943a4a92a'},{productId:'10112766',inventoryId:'57b4b2b5-d6ad-435a-b303-5d412405a44c'}];
 let data=process.argv.includes('--refresh')?await refreshManualSync():await readManualSync();
 const results=[];
 for(const p of plan){
  const before=await getInventoryRaw(p.inventoryId),remote=data.snapshot?.products.find(x=>x.productId===p.productId);
  if(!before||!remote)throw Error('MISSING');
  if(process.argv.includes('--apply')&&!data.links.some(l=>l.productId===p.productId&&l.inventoryId===p.inventoryId))data=await linkExternalProduct({...p,confirmed:true,version:data.snapshot!.version,fingerprint:productFingerprint(remote)},'BELLO_VISUAL_REVIEW_20261112',true);
  const after=await getInventoryRaw(p.inventoryId);
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('INVENTORY_CHANGED_REVIEW_REQUIRED');
  results.push({...p,linked:data.links.some(l=>l.productId===p.productId&&l.inventoryId===p.inventoryId),inventoryUnchanged:true,channels:Object.fromEntries((['BASE','YAHOO','MERCARI_SHOPS'] as const).map(c=>[c,selectManualLink(data,p.inventoryId,c)?.productId]))});
 }
 const flows=await readEconveniCatalog(),owners=new Map<string,Set<string>>();
 for(const l of [...data.links,...flows.map(f=>({productId:f.save.productId,inventoryId:f.inventoryId}))])if(l.productId)owners.set(l.productId,new Set([...(owners.get(l.productId)??[]),l.inventoryId]));
 const ids=[...new Set((data.snapshot?.products??[]).flatMap(p=>[...(owners.get(p.productId)??[])]))];
 const live=new Map<string,boolean>();for(let i=0;i<ids.length;i+=10)await Promise.all(ids.slice(i,i+10).map(async id=>{const item=await getInventoryRaw(id);live.set(id,!!item&&!item.isDeleted&&!item.deletedAt&&item.listingPartition!=='MERGED');}));
 const missing=(data.snapshot?.products??[]).filter(p=>owners.get(p.productId)?.size!==1||![...(owners.get(p.productId)??[])].every(id=>live.get(id))).map(p=>({productId:p.productId,title:p.title}));
 const report={checkedAt:data.snapshot?.checkedAt,total:data.snapshot?.products.length,linked:(data.snapshot?.products.length??0)-missing.length,missing,results};
 writeFileSync('artifacts/econveni-parity-20261112/link-complete.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.name,e.message);process.exitCode=1;});
