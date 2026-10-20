/** Offline mapping round-trip using the separately captured read-only backups. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {applyFields,localFields,remoteFields,type Masters} from '../../lib/zaico/transition/mapping';
import {changedFields} from '../../lib/zaico/transition/protocol';
async function main(){
 const dir=process.argv[2];assert.ok(dir);
 const snapshot=JSON.parse(fs.readFileSync(path.join(dir,'初回同期前_BELLO読取バックアップ.json'),'utf8'));
 const remote=JSON.parse(fs.readFileSync(path.join(dir,'初回同期前_ZAICO読取バックアップ.json'),'utf8')).remote;
 const masters:Masters={categories:snapshot.Category,locations:snapshot.Location,statuses:snapshot.StatusMaster,
  resolve:async(kind,name)=>{
   const list=kind==='Category'?masters.categories:kind==='Location'?masters.locations:masters.statuses;
   const field=kind==='StatusMaster'?'label':'name';
   let row=list.find(r=>String(r[field]).normalize('NFKC').trim()===name.normalize('NFKC').trim());
   if(!row){row={id:`QA-${kind}-${name}`,[field]:name};list.push(row);}return row.id;
  }};
 const bySource=new Map<string,any>(snapshot.Inventory.map((r:any)=>[String(r.sourceInventoryId),r]));
 let checked=0,raw=0,blank=0;const failures:unknown[]=[];
 for(const item of remote){
  if(item.deleted)continue;
  try{
   const mapped=await remoteFields(item,masters);
   const row={...bySource.get(String(item.id)),...applyFields(bySource.get(String(item.id))??{id:String(item.id)},mapped.fields,mapped.raw)};
   assert.deepEqual(changedFields(mapped.fields,localFields(row)),{},'Mapping must not generate outbound differences');
   if(Object.keys(mapped.raw).length)raw++;
   if(row.quantity===null)blank++;
   checked++;
  }catch(e){failures.push({id:item.id,error:e instanceof Error?e.message:String(e)});}
 }
 const result={checked,raw,blank,failures,zaicoWrites:0,productionWrites:0};
 fs.writeFileSync(path.join(dir,'新同期_全商品変換検証.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,failures:failures.slice(0,10)},null,2));
 assert.equal(failures.length,0);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
