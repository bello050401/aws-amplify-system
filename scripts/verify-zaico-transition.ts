import assert from 'node:assert/strict';
import {mergeZaicoUpdate} from '../lib/inventory/zaicoSyncMerge';
import {syncOneZaicoItem} from '../lib/inventory/zaicoSyncEngine';
import type {ZaicoSyncPort,InventoryModel} from '../lib/inventory/zaicoSyncPorts';
import type {ZaicoInventory} from '../lib/zaico/client';
import {activate,beginInitial,completeInitial,enqueueChange,finalize,reconcileFields,shouldPoll,requiresDailyCheck,type TransitionSettings} from '../lib/zaico/transition/protocol';
import {createV2Client,toLegacyInventory,ZaicoHttpError,type V2Inventory} from '../lib/zaico/transition/v2Client';
import {initialOptionalFields,InitialMappingError} from '../lib/zaico/transition/initialOptionalFields';

async function main(){
 let assertions=0;
 const check=(ok:unknown)=>{assert.ok(ok);assertions++};
 const zaico={name:'ZAICO商品',quantity:3,categoryIds:['sale','dealer'],locationId:null,note:null,
   extendedFields:{adminMemo:'123',width:'45'},customFields:{material:'木'}};
 const bello={name:'古いBELLO商品',quantity:9,categoryIds:['moving'],locationId:'warehouse',note:'変更前',
   extendedFields:{adminMemo:'旧値',width:'60',belloOnly:'維持'},customFields:{material:'鉄',belloOnly:'独自情報',__belloEditedFields:['name','customFields.material','customFields.belloOnly']}};
 const initial=mergeZaicoUpdate({zaico,bello,snapshotJson:null,isNewRecord:false,mode:'ZAICO_BASELINE'});
 assert.deepEqual(initial.updates,{name:'ZAICO商品',quantity:3,categoryIds:['sale','dealer'],locationId:null,note:null,categoryId:'sale'});
 assert.equal(initial.customFields.belloOnly,'独自情報');
 assert.deepEqual(initial.customFields.__belloEditedFields,['customFields.belloOnly']);
 check(initial.baselineDifferences.some(d=>d.field==='name'&&d.belloValue==='古いBELLO商品'));
 // Opt-in bootstrap must not change existing MERGE/SNAPSHOT_ONLY behavior.
 const snapshot=mergeZaicoUpdate({zaico,bello,snapshotJson:null,isNewRecord:false,mode:'SNAPSHOT_ONLY'});
 check(!snapshot.writesBusinessValues&&Object.keys(snapshot.updates).length===0);
 const raw:ZaicoInventory={id:777,title:'ZAICO商品',quantity:3,unit:'',category:'',state:'',place:'',etc:'',code:'123',item_image:null,
   optional_attributes:[{name:'★市川メモ',value:'123'}]};
 const existing={id:'fixture',sourceSystem:'ZAICO',sourceInventoryId:'777',name:'旧商品',quantity:9,
   categoryId:'old-category',categoryIds:['old-category'],locationId:'old-place',unit:'脚',note:'旧備考',
   statusId:'old-state',salePrice:2000,plannedSalePrice:1000,
   updatedAt:'2026-10-20T00:00:00Z',customFields:'{}',images:[],sku:'FIXTURE'} as unknown as InventoryModel;
 let archived=false,writes=0;
 const port={
   findExistingBySourceId:async()=>existing,
   updateInventory:async(input:Record<string,unknown>)=>{
    check(archived);check(input.expectedUpdatedAt===existing.updatedAt);
    assert.deepEqual(input.categoryIds,[]);assert.equal(input.locationId,null);assert.equal(input.note,null);
    assert.equal(input.statusId,null);assert.equal(input.salePrice,null);
    assert.equal((input.extendedFields as Record<string,unknown>).plannedSalePrice,null);
    writes++;
   },logHistory:async()=>{},
 } as unknown as ZaicoSyncPort;
 const withoutBackup=await syncOneZaicoItem(raw,'fixture',undefined,port,undefined,'ZAICO_BASELINE');
 check(withoutBackup.status==='failed'&&writes===0);
 port.archiveBeforeInitialSync=async()=>{throw Error('backup unavailable')};
 check((await syncOneZaicoItem(raw,'fixture',undefined,port,undefined,'ZAICO_BASELINE')).status==='failed'&&writes===0);
 port.archiveBeforeInitialSync=async(row)=>{assert.equal(row.quantity,9);archived=true};
 check((await syncOneZaicoItem(raw,'fixture',undefined,port,undefined,'ZAICO_BASELINE')).status==='updated'&&writes===1);
 // A populated upstream state must never be silently lost by an older adapter.
 check((await syncOneZaicoItem({...raw,state:'良好'},'fixture',undefined,port,undefined,'ZAICO_BASELINE')).status==='failed'&&writes===1);
 check((await syncOneZaicoItem({...raw,quantity:1.5},'fixture',undefined,port,undefined,'ZAICO_BASELINE')).status==='failed'&&writes===1);
 check((await syncOneZaicoItem({...raw,quantity:'1.5'},'fixture',undefined,port,undefined,'ZAICO_BASELINE')).status==='failed'&&writes===1);
 const splitPort={...port,findExistingBySourceId:async()=>({...existing,customFields:'{"__belloStockSplit":{}}'})};
 check((await syncOneZaicoItem(raw,'fixture',undefined,splitPort,undefined,'ZAICO_BASELINE')).status==='failed'&&writes===1);
 let reservations=0,releases=0;
 const newPort={...port,findExistingBySourceId:async()=>null,claimSourceLink:async()=>{reservations++;return {claimed:true}},releaseSourceLink:async()=>{releases++}} as unknown as ZaicoSyncPort;
 const rejected=await syncOneZaicoItem({...raw,quantity:1.5},'fixture',undefined,newPort,undefined,'ZAICO_BASELINE');
 check(rejected.status==='failed'&&reservations===1&&releases===1);
 let created:Record<string,any>|undefined;
 newPort.generateSku=async()=>'NEW-TEST';
 newPort.createInventory=async(input)=>{created=input;return {...input,updatedAt:'2026-10-20T00:00:00Z'} as unknown as InventoryModel};
 check((await syncOneZaicoItem({...raw,quantity:null,optional_attributes:[{name:'⚫︎販売価格',value:'１２，０００'}]},'fixture',undefined,newPort,undefined,'ZAICO_BASELINE')).status==='created');
 assert.equal(created?.quantity,null);
 assert.equal(created?.salePrice,12000);
 assert.equal(JSON.parse(created!.zaicoSnapshotJson).quantity,null);
 assert.equal(JSON.parse(created!.zaicoSnapshotJson).salePrice,12000);
 assert.equal(initialOptionalFields([{name:'⚫︎数量',value:'２'}]).extendedFields.purchaseQuantity,2);
 assert.throws(()=>initialOptionalFields([{name:'⚫︎数量',value:'数点'}]),InitialMappingError);
 assert.throws(()=>initialOptionalFields([{name:'⚫︎取引の年月日',value:'45238'}]),InitialMappingError);
 const v2={...raw,state:'',optional_attributes:{'★市川メモ':'123'},deleted:false} as V2Inventory;
 assert.equal(toLegacyInventory(v2).optional_attributes?.[0].value,'123');
 assert.throws(()=>toLegacyInventory({...v2,optional_attributes:undefined} as unknown as V2Inventory));
 assert.throws(()=>toLegacyInventory({...v2,deleted:true}));
 assert.throws(()=>toLegacyInventory({...v2,quantity:Number.NaN}));
 const incomplete={...v2} as Partial<V2Inventory>;delete incomplete.quantity;
 assert.throws(()=>toLegacyInventory(incomplete as V2Inventory));
 const settings:TransitionSettings={phase:'DISABLED',companyId:184402,pollMinutes:5};
 assert.throws(()=>activate(settings));
 const boot=beginInitial(settings,'run-1');
 assert.throws(()=>completeInitial(boot,{runId:'run-1',completedAt:'x',watermark:'x',failed:1,backupVerified:true,allPagesRead:true}));
 const ready=completeInitial(boot,{runId:'run-1',completedAt:'2026-10-20T00:00:00Z',watermark:'2026-10-19T23:59:00Z',failed:0,backupVerified:true,allPagesRead:true});
 assert.throws(()=>completeInitial(boot,{runId:'run-1',completedAt:'invalid',watermark:'invalid',failed:0,backupVerified:true,allPagesRead:true}));
 const active=activate(ready);
 const event={settings:active,inventoryId:'1',eventId:'e1',revision:'r1',origin:'BELLO' as const,before:{title:'A',quantity:1},after:{title:'A',quantity:2},now:0};
 check(enqueueChange({...event,settings:boot})===undefined);
 check(enqueueChange({...event,settings:ready})?.desired.quantity===2);
 check(enqueueChange({...event,origin:'ZAICO'})===undefined);
 check(enqueueChange({...event,after:event.before})===undefined);
 const pending=enqueueChange(event)!;
 check(enqueueChange({...event,existing:pending})===pending);
 const pending2=enqueueChange({...event,existing:pending,eventId:'e2',revision:'r2',before:event.after,after:{title:'A',quantity:3},now:1000})!;
 check(pending2.base.quantity===1&&pending2.desired.quantity===3&&pending2.dueAt===16000);
 check(enqueueChange({...event,existing:pending2,eventId:'e3',before:pending2.desired,after:event.before})===undefined);
 const merge=reconcileFields({title:'A',quantity:1},{title:'B',quantity:2},{title:'C',quantity:1});
 assert.deepEqual(merge.toBello,{title:'C'});assert.deepEqual(merge.toZaico,{quantity:2});
 check(merge.conflicts.length===1&&merge.conflicts[0].bello==='B');
 check(Object.keys(reconcileFields({title:'A'},{title:'B'},{title:'B'}).toZaico).length===0);
 check(!shouldPoll({...active,phase:'STOPPED'},Date.now()));
 check(requiresDailyCheck(active,Date.parse('2026-10-22T00:00:00Z')));
 assert.throws(()=>finalize({...active,phase:'FINALIZING'},{adminConfirmed:true,pending:1,conflicts:0,failed:0,allRecordsCompared:true,finalDeltaCompleted:true,writeFenceVerified:true}));
 assert.equal(finalize({...active,phase:'FINALIZING'},{adminConfirmed:true,pending:0,conflicts:0,failed:0,allRecordsCompared:true,finalDeltaCompleted:true,writeFenceVerified:true}).phase,'STOPPED');
 let clock=0,calls=0,guards=0;const delays:number[]=[],urls:string[]=[];
 const client=createV2Client({companyId:184402,token:async()=>'test-only',beforeRequest:async()=>{guards++},now:()=>clock,sleep:async ms=>{clock+=ms;delays.push(ms)},
   fetch:async(url)=>{urls.push(String(url));calls++;if(calls===1)return new Response('',{status:429,headers:{'Retry-After':'2'}});
    return Response.json({data:[],pagination:{current_page:1,total_pages:0,total_count:0}})}});
 await client.list({start:'2026-10-20T00:00:00Z',end:'2026-10-20T00:05:00Z',page:1});
 check(calls===2&&guards===2&&delays.includes(2000)&&urls[0].includes('include_deleted=true'));
 let writesAttempted=0;
 const uncertain=createV2Client({companyId:1,token:async()=>'test-only',beforeRequest:async()=>{},fetch:async()=>{writesAttempted++;throw Error('lost reply')}});
 await assert.rejects(uncertain.create({title:'test'}),e=>e instanceof ZaicoHttpError&&e.outcomeUnknown);
 check(writesAttempted===1);
 const stopped=createV2Client({companyId:1,token:async()=>'test-only',beforeRequest:async()=>{throw Error('stopped')},fetch:async()=>{throw Error('must not reach fetch')}});
 await assert.rejects(stopped.get('1'),/stopped/);
 // Concurrent callers share one queue; each API start remains >=1 s apart.
 const starts:number[]=[];let testTime=0;
 const serial=createV2Client({companyId:1,token:async()=>'test',beforeRequest:async()=>{},now:()=>testTime,
  sleep:async ms=>{testTime+=ms},fetch:async(url)=>{starts.push(testTime);await Promise.resolve();return Response.json({data:{...v2,id:Number(String(url).match(/\/(\d+)\.json$/)![1])}})}});
 await Promise.all([serial.get('1'),serial.get('2'),serial.get('3')]);
 assert.deepEqual(starts,[0,1000,2000]);
 let guardPhase='ACTIVE',postCalls=0;
 const fence=createV2Client({companyId:1,token:async()=>{guardPhase='STOPPED';return 'test'},beforeRequest:async method=>{
  if(method!=='GET'&&guardPhase!=='ACTIVE')throw Error('write fence');
 },fetch:async()=>{postCalls++;return Response.json({})}});
 await assert.rejects(fence.patch('1',{title:'changed'}),/write fence/);
 assert.equal(postCalls,0);
 console.log(`PASS: ${assertions} transition checks plus exact-value assertions. Initial ZAICO priority, mandatory backup, no outgoing before baseline, debounce, no-op, origin/echo, conflict preservation, stop gate, v2 pagination/retry. No live writes.`);
}
main().catch(e=>{console.error(e);process.exitCode=1});
