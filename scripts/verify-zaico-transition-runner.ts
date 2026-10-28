import assert from 'node:assert/strict';
import {runTransition,type TransitionPort} from '../lib/zaico/transition/runner';
import {localFields,remoteFields,outgoingPatch,type Row,type Masters,RAW_VALUES} from '../lib/zaico/transition/mapping';
import type {V2Inventory} from '../lib/zaico/transition/v2Client';
import type {Control} from '../lib/zaico/transition/store';
import {sourceDatePatch} from '../lib/zaico/transition/sourceDates';
const clone=<T>(v:T):T=>structuredClone(v);
const remote=(id:number,title='ZAICOの商品'):V2Inventory=>({id,title,quantity:'3',unit:'個',category:'販売中,業者間',state:'良品',place:'川越',etc:'備考',code:'2026102100001',optional_attributes:{'⚫︎購入価格':'２００','⚫︎販売開始日':'45238'},deleted:false} as V2Inventory);
export function harness(){
  let now=Date.parse('2026-10-21T10:00:00Z'),seq=0;
  let control:Control={id:'transition#control',phase:'BASELINING',companyId:184402,pollMinutes:5,initialRunId:'test'};
  const rows=new Map<string,Row>(),states=new Map<string,Row>(),archives=new Map<string,unknown>(),remotes=new Map<string,V2Inventory>();
  const calls:{method:string;id?:string;body?:any}[]=[];
  const masters:Masters={categories:[],locations:[],statuses:[],resolve:async(kind,name)=>{
    const list=kind==='Category'?masters.categories:kind==='Location'?masters.locations:masters.statuses;
    const field=kind==='StatusMaster'?'label':'name';
    let item=list.find(r=>r[field]===name);if(!item){item={id:kind+name,[field]:name};list.push(item);}return item.id;
  }};
  let failBackup=false,failCreate=false,refusePatch=false,afterPatch:(()=>void)|undefined;
  const port:TransitionPort={
    getControl:async()=>clone(control),saveControl:async(c)=>control=clone(c),
    states:async()=>clone([...states.values()]),saveState:async(s)=>{
      if(states.get(s.inventoryId)?.version!==s.version)throw Error('Stale sync-state version');
      const saved:Row={...clone(s),version:String(++seq)};states.set(saved.inventoryId,saved);return clone(saved);
    },
    inventories:async()=>clone([...rows.values()]),inventory:async(id)=>clone(rows.get(id)),
    masters:async()=>masters,
    archive:async(label,value)=>{if(failBackup)throw Error('backup failed');const key=label+'/'+seq++;archives.set(key,clone(value));return key;},
    readArchive:async(key)=>clone(archives.get(key)) as import('../lib/zaico/transition/runner').SyncWindow,
    saveInventory:async(row,expected)=>{
      if(expected!==rows.get(row.id)?.updatedAt)throw Error('CONFLICT');
      const saved={...rows.get(row.id),...clone(row),updatedAt:new Date(now+ ++seq).toISOString()};
      rows.set(row.id,saved);return clone(saved);
    },
    deleteInventory:async(row)=>{if(row.updatedAt!==rows.get(row.id)?.updatedAt)throw Error('CONFLICT');rows.delete(row.id);},
    saveSourceDates:async(row,remote,includeUpdated)=>{
      if(row.updatedAt!==rows.get(row.id)?.updatedAt)throw Error('CONFLICT');
      const saved={...row,...sourceDatePatch(row,remote,includeUpdated)};rows.set(row.id,saved);return clone(saved);
    },
    generateSku:async()=>'QA'+(++seq),syncImage:async(row)=>row,history:async()=>{},
    api:{
      list:async(input)=>{calls.push({method:'LIST'});return {data:clone([...remotes.values()]),pagination:{current_page:input.page,total_pages:1,total_count:remotes.size}};},
      get:async(id)=>{calls.push({method:'GET',id});return clone(remotes.get(id)??null);},
      patch:async(id,body)=>{
        calls.push({method:'PATCH',id,body});
        if(!refusePatch)remotes.set(id,{...remotes.get(id)!,...body as Row,...(body.item_image?{item_image:{url:'https://images.zaico.example/'+id+'.jpg'}}:{})});
        afterPatch?.();return {data:clone(remotes.get(id))};
      },
      create:async(body)=>{
        calls.push({method:'POST',body});if(failCreate)throw Error('uncertain create');
        const next={...remote(999),...body as Row};remotes.set('999',next);return {data:clone(next)};
      },
      remove:async(id)=>{calls.push({method:'DELETE',id});remotes.delete(id);return null;}
    },now:()=>now,deadline:now+210000,
  };
  const run=async()=>{port.deadline=now+210000;await runTransition(port);};
  const tick=async()=>{now+=301000;await run();};
  const seed=()=>{remotes.set('1',remote(1));rows.set('one',{id:'one',sku:'B1',sourceSystem:'ZAICO',sourceInventoryId:'1',name:'BELLO旧名',quantity:99,categoryIds:[],customFields:JSON.stringify({belloOnly:'keep'}),updatedAt:'2026-10-20T00:00:00Z'});};
  return {rows,states,remotes,calls,archives,port,masters,run,tick,seed,
    get control(){return control;},set control(v){control=v;},
    set failBackup(v:boolean){failBackup=v;},set failCreate(v:boolean){failCreate=v;},
    set refusePatch(v:boolean){refusePatch=v;},set afterPatch(v:(()=>void)|undefined){afterPatch=v;}};
}
let checks=0;
async function test(name:string,fn:()=>Promise<void>){await fn();checks++;console.log('PASS '+name);}
async function main(){
  await test('Initial source wins, numeric blank/raw preserved, no outbound',async()=>{
    const h=harness();h.seed();await h.run();
    assert.equal(h.rows.get('one')!.name,'ZAICOの商品');assert.equal(h.rows.get('one')!.quantity,3);
    assert.equal(h.rows.get('one')!.purchasePrice,200);
    assert.equal(h.rows.get('one')!.saleStartDate,null);
    const cf=JSON.parse(h.rows.get('one')!.customFields);assert.equal(cf.belloOnly,'keep');assert.equal(cf[RAW_VALUES].saleStartDate.value,'45238');
    assert.deepEqual(h.rows.get('one')!.categoryIds,['Category業者間','Category販売中'].sort());
    assert.equal(h.control.phase,'ACTIVE');assert.ok(h.control.backupKey);assert.equal(h.calls.filter(c=>['PATCH','POST','DELETE'].includes(c.method)).length,0);
  });
  await test('No-op save, display and inbound echo produce no per-product request',async()=>{
    const h=harness();h.seed();await h.run();h.calls.length=0;
    h.rows.get('one')!.updatedAt='2026-10-21T10:00:01Z';await h.tick();
    assert.deepEqual(h.calls.map(c=>c.method),['LIST']);
  });
  await test('A genuine local edit is coalesced and verified once',async()=>{
    const h=harness();h.seed();await h.run();h.calls.length=0;
    h.rows.get('one')!.name='編集中1';h.rows.get('one')!.name='最終編集';
    await h.tick();assert.equal(h.remotes.get('1')!.title,'最終編集');
    assert.equal(h.calls.filter(c=>c.method==='PATCH').length,1);
    h.calls.length=0;await h.tick();assert.deepEqual(h.calls.map(c=>c.method),['LIST']);
  });
  await test('Same-field conflict keeps ZAICO and archives BELLO; independent edit survives',async()=>{
    const h=harness();h.seed();await h.run();
    h.rows.get('one')!.name='BELLO未反映';h.rows.get('one')!.note='BELLO備考';
    h.remotes.get('1')!.title='ZAICO優先';await h.tick();
    assert.equal(h.rows.get('one')!.name,'ZAICO優先');assert.equal(h.remotes.get('1')!.etc,'BELLO備考');
    assert.equal(h.states.get('one')!.conflict.fields[0].bello,'BELLO未反映');
  });
  await test('Backup failure prevents initial data changes and outbound activation',async()=>{
    const h=harness();h.seed();h.failBackup=true;
    await assert.rejects(h.run(),/backup/);assert.equal(h.rows.get('one')!.quantity,99);assert.equal(h.control.phase,'BASELINING');
  });
  await test('Explicit upstream tombstone deletes locally only after archive',async()=>{
    const h=harness();h.seed();await h.run();h.remotes.set('1',{...remote(1),deleted:true});await h.tick();
    assert.equal(h.rows.has('one'),false);assert.ok([...h.archives.keys()].some(k=>k.startsWith('before-delete')));assert.equal(h.states.get('one')!.status,'DELETED');
  });
  await test('Local deletion reaches upstream only if source unchanged',async()=>{
    const h=harness();h.seed();await h.run();h.rows.delete('one');await h.tick();
    assert.equal(h.calls.filter(c=>c.method==='DELETE').length,1);assert.equal(h.states.get('one')!.status,'DELETED');
  });
  await test('Database map key order cannot produce a false deletion conflict',async()=>{
    const h=harness();h.seed();await h.run();
    const state=h.states.get('one')!;
    state.remoteBase=Object.fromEntries(Object.entries(state.remoteBase).reverse());
    state.remote=Object.fromEntries(Object.entries(state.remote).reverse());
    h.rows.delete('one');await h.tick();
    assert.equal(h.calls.filter(c=>c.method==='DELETE').length,1);
    assert.equal(h.states.get('one')!.status,'DELETED');
    assert.equal(h.states.get('one')!.error,null);
  });
  await test('Unchanged persisted maps do not rewrite sync state because of key order',async()=>{
    const h=harness();h.seed();await h.run();
    const state=h.states.get('one')!;
    state.remoteBase=Object.fromEntries(Object.entries(state.remoteBase).reverse());
    state.localBase=Object.fromEntries(Object.entries(state.localBase).reverse());
    state.remote.optional_attributes=Object.fromEntries(Object.entries(state.remote.optional_attributes).reverse());
    let writes=0;const save=h.port.saveState;
    h.port.saveState=async row=>{writes++;return save(row);};
    await h.tick();assert.equal(writes,0);
  });
  await test('Delete against a changed upstream is held for review',async()=>{
    const h=harness();h.seed();await h.run();h.rows.delete('one');h.remotes.get('1')!.title='changed';await h.tick();
    assert.equal(h.calls.filter(c=>c.method==='DELETE').length,0);assert.equal(h.states.get('one')!.status,'CONFLICT');
  });
  await test('Lost deletion acknowledgement recovers from a confirmed 404 without repeating DELETE',async()=>{
    const h=harness();h.seed();await h.run();h.rows.delete('one');
    const remove=h.port.api.remove;
    h.port.api.remove=async id=>{await remove(id);throw Error('Lost deletion reply');};
    await h.tick();assert.equal(h.states.get('one')!.status,'ERROR');
    await h.tick();assert.equal(h.states.get('one')!.status,'DELETED');
    assert.equal(h.states.get('one')!.error,null);
    assert.equal(h.calls.filter(c=>c.method==='DELETE').length,1);
  });
  await test('New local item creates exactly once and links its source ID',async()=>{
    const h=harness();h.seed();await h.run();h.rows.set('two',{id:'two',name:'新しい商品',quantity:2,categoryIds:[],updatedAt:'2026-10-20T00:00:00Z'});
    await h.tick();assert.equal(h.rows.get('two')!.sourceInventoryId,'999');
    await h.tick();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
  });
  await test('Lost create acknowledgement is never blindly retried',async()=>{
    const h=harness();h.seed();await h.run();h.rows.set('two',{id:'two',name:'新しい商品',quantity:2,categoryIds:[],updatedAt:'2026-10-20T00:00:00Z'});h.failCreate=true;
    await h.tick();await h.tick();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.equal(h.states.get('two')!.status,'CREATE_UNCONFIRMED');
  });
  await test('Refused upstream fields are errors, not success',async()=>{
    const h=harness();h.seed();await h.run();h.rows.get('one')!.name='reject';h.refusePatch=true;await h.tick();
    assert.equal(h.states.get('one')!.status,'WRITE_REJECTED');assert.match(h.states.get('one')!.error,/保存を確認/);
    h.calls.length=0;await h.tick();assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);
  });
  await test('Concurrent local edits during remote write remain pending',async()=>{
    const h=harness();h.seed();await h.run();h.rows.get('one')!.name='first';
    h.afterPatch=()=>{h.rows.get('one')!.name='second';h.afterPatch=undefined;};
    await h.tick();assert.equal(h.remotes.get('1')!.title,'first');assert.equal(h.rows.get('one')!.name,'second');
    await h.tick();assert.equal(h.remotes.get('1')!.title,'second');
  });
  await test('STOPPED performs zero local scans or external calls',async()=>{
    const h=harness();h.control={...h.control,phase:'STOPPED'};
    h.port.inventories=async()=>{throw Error('should not scan');};await h.run();assert.equal(h.calls.length,0);
  });
  await test('Interrupted initial sync resumes without discarding edits to completed products',async()=>{
    const h=harness();h.seed();h.remotes.set('2',remote(2,'second'));
    const save=h.port.saveInventory;
    h.port.saveInventory=async(...args)=>{const result=await save(...args);h.port.deadline=h.port.now()+25_000;return result;};
    await h.run();assert.equal(h.control.phase,'BASELINING');assert.equal(h.states.get('one')!.status,'OK');
    h.rows.get('one')!.name='初回同期中の編集';h.port.saveInventory=save;
    await h.run();assert.equal(h.control.phase,'ACTIVE');assert.equal(h.rows.get('one')!.name,'初回同期中の編集');
    await h.tick();assert.equal(h.remotes.get('1')!.title,'初回同期中の編集');
  });
  await test('Initial omission is confirmed individually, never inferred from an incomplete list',async()=>{
    const h=harness();h.seed();h.port.api.list=async()=>({data:[],pagination:{current_page:1,total_pages:0,total_count:0}});
    await h.run();assert.equal(h.rows.get('one')!.quantity,3);assert.equal(h.calls.filter(c=>c.method==='GET').length,1);
  });
  await test('Inconsistent pagination never activates outgoing sync',async()=>{
    const h=harness();h.seed();h.port.api.list=async()=>({data:[remote(1)],pagination:{current_page:1,total_pages:1,total_count:2}});
    await assert.rejects(h.run(),/件数/);assert.equal(h.control.phase,'BASELINING');assert.equal(h.rows.get('one')!.quantity,99);
  });
  await test('Admin stop rechecks fresh changes and waits until all are reconciled',async()=>{
    const h=harness();h.seed();await h.run();
    h.control={...h.control,phase:'FINALIZING',stopRequestedAt:'2026-10-21T10:00:00Z',nextRunAt:0};
    await h.tick();assert.equal(h.control.phase,'FINALIZING');
    const list=h.port.api.list;h.port.api.list=async(input)=>input.start?
      {data:[],pagination:{current_page:1,total_pages:0,total_count:0}}:list(input);
    await h.tick();assert.equal(h.control.phase,'STOPPED');
    h.calls.length=0;await h.tick();assert.equal(h.calls.length,0);
  });
  await test('Reverse optional mapping preserves unknown source values',async()=>{
    const h=harness(),r=remote(1);r.optional_attributes!['未知の項目']='残す';r.optional_attributes!['未入力の項目']=null;
    const p=outgoingPatch({purchasePrice:300},r,h.masters);
    assert.equal(p.optional_attributes['未知の項目'],'残す');assert.equal(p.optional_attributes['⚫︎購入価格'],'300');
    assert.equal(p.optional_attributes['未入力の項目'],'');
    assert.ok(Object.values(p.optional_attributes).every(value=>typeof value==='string'));
    h.masters.attributeNames=['⚪︎コンディション評価(1～5の5段階で)'];
    const create=outgoingPatch({conditionRating:'4',purchasePrice:null},undefined,h.masters);
    assert.deepEqual(create.optional_attributes,{'⚪︎コンディション評価(1～5の5段階で)':'4'});
  });

  const withPhoto=async()=>{const h=harness();h.seed();const row=h.rows.get('one')!;row.customFields=JSON.stringify({__restageImport:{goodsId:'test'}});row.images=[{type:'NORMAL',isPrimary:true,storageKey:'inventory/test.jpg'}];h.port.readPrimaryImage=async()=> 'data:image/jpeg;base64,test';await h.run();return h;};
  await test('仕入写真は初回基準取込後に空のZAICO写真だけへ1回送信',async()=>{
    const h=await withPhoto();assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);const before=localFields(h.rows.get('one')!);
    await h.tick();assert.deepEqual(h.calls.filter(c=>c.method==='PATCH').map(c=>Object.keys(c.body)),[['item_image']]);assert.deepEqual(localFields(h.rows.get('one')!),before);assert.equal(h.rows.get('one')!.images.length,1);assert.ok(h.states.get('one')!.imageExport.url);
    h.calls.length=0;await h.tick();assert.deepEqual(h.calls.map(c=>c.method),['LIST']);
  });
  await test('ZAICO既存写真と他商品の写真は上書きしない',async()=>{
    const h=await withPhoto();h.remotes.get('1')!.item_image={url:'https://existing.example/a.jpg'};await h.tick();assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);
    const other=harness();other.seed();await other.run();other.rows.get('one')!.images=[{type:'NORMAL',storageKey:'inventory/a.jpg'}];other.port.readPrimaryImage=async()=>{throw Error('should not read');};await other.tick();assert.equal(other.calls.filter(c=>c.method==='PATCH').length,0);
  });
  await test('写真送信の応答消失はGETで復旧し重複送信・取込を防ぐ',async()=>{
    const h=await withPhoto();let own:string|undefined;h.port.syncImage=async(row,remote,url)=>{own=url;return row;};
    h.afterPatch=()=>{throw Error('reply lost');};await h.tick();assert.equal(h.states.get('one')!.status,'ERROR');h.afterPatch=undefined;await h.tick();assert.equal(h.states.get('one')!.status,'OK');assert.ok(own);assert.equal(h.calls.filter(c=>c.method==='PATCH').length,1);
  });
  await test('写真読込失敗は成功扱いせず原本を保持し再試行できる',async()=>{
    const h=await withPhoto();h.port.readPrimaryImage=async()=>{throw Error('read failed');};await h.tick();assert.equal(h.states.get('one')!.status,'ERROR');assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);assert.equal(h.rows.get('one')!.images.length,1);h.port.readPrimaryImage=async()=> 'data:image/jpeg;base64,test';await h.tick();assert.equal(h.states.get('one')!.status,'OK');assert.ok(h.states.get('one')!.imageExport);
  });
  await test('送信後にZAICOで削除した写真を復活させない',async()=>{
    const h=await withPhoto();await h.tick();h.remotes.get('1')!.item_image=null as any;h.calls.length=0;await h.tick();assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);
  });
  await test('新規仕入商品は本文を作成してから写真を送り二重作成しない',async()=>{
    const h=harness();h.seed();await h.run();h.rows.set('two',{id:'two',name:'新規仕入',quantity:1,categoryIds:[],customFields:JSON.stringify({__restageImport:{goodsId:'new'}}),images:[{type:'NORMAL',storageKey:'inventory/new.jpg'}],updatedAt:'2026-10-20T00:00:00Z'});h.port.readPrimaryImage=async()=> 'data:image/jpeg;base64,test';await h.tick();await h.tick();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.equal(h.calls.filter(c=>c.method==='PATCH'&&c.body.item_image).length,1);
  });
  await test('ヤフオク新規商品は台帳と写真が連動し再同期で二重作成しない',async()=>{
    const h=harness();h.seed();await h.run();h.rows.set('two',{id:'two',name:'ヤフオク仕入',quantity:2,categoryIds:[],identityVerificationMethod:'対面している相手の勤務先や家族などに、身元確認の問い合わせ',counterpartyOccupation:'リサイクル販売業',customFields:JSON.stringify({__yahooPurchaseImport:{auctionId:'r1234567890'},usedGoodsFeature:'品目：テーブル／色：ホワイト'}),images:[{type:'NORMAL',storageKey:'inventory/new.jpg'}],updatedAt:'2026-10-20T00:00:00Z'});h.port.readPrimaryImage=async()=> 'data:image/jpeg;base64,test';await h.tick();await h.tick();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.equal(h.calls.filter(c=>c.method==='PATCH'&&c.body.item_image).length,1);assert.equal(h.remotes.get('999')!.optional_attributes!['⚫︎古物の特徴'],'品目：テーブル／色：ホワイト');assert.equal(h.states.get('two')!.status,'OK');
  });
  console.log(`PASS ${checks} transition workflow scenarios`);
}
if(process.argv[1]?.endsWith('verify-zaico-transition-runner.ts'))main().catch(e=>{console.error(e);process.exitCode=1;});
