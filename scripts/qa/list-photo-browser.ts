// Isolated localhost harness. No authentication, inventory API, S3 writes or production records.
import {listPhotoRepository as repo} from '../../mobile/src/runtime/listPhotoRepository.web';
import {ListPhotoCache,newestPhotoTargets,LIST_PHOTO_BYTES} from '../../mobile/src/domain/listPhotoCache';
import {previewItems} from '../../mobile/src/preview/fixture';
const rows=Array.from({length:1500},(_,i)=>({...previewItems[0],id:'browser-photo-'+i,name:`写真保存確認 ${i}`,displayId:String(1000+i),updatedAt:new Date(1700000000000+i*1000).toISOString(),listUpdatedAt:new Date(1700000000000+i*1000).toISOString()}));
const output=document.querySelector('pre')!,gallery=document.querySelector('#gallery')!;
const log=(s:string)=>{output.textContent+='\n'+s;};
const urls:string[]=[];
async function disk(){
 const db=await new Promise<IDBDatabase>((ok,no)=>{const r=indexedDB.open('bello-list-photos-v1',1);r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
 const result=await new Promise<{entries:any[];meta:any}>((ok,no)=>{const t=db.transaction(['images','meta']);const r=t.objectStore('images').getAll(),m=t.objectStore('meta').get('current');t.oncomplete=()=>ok({entries:r.result,meta:m.result});t.onerror=()=>no(t.error);});db.close();return result;
}
function check(ok:boolean,label:string){if(!ok)throw Error(label);log('PASS '+label);}
async function show(){
 const d=await disk();log(`保存先の実測：${d.entries.filter(e=>e.blob).length}枚 / ${d.entries.reduce((s,e)=>s+(e.blob?.size??0),0)} bytes`);
 for(const url of urls)URL.revokeObjectURL(url);urls.length=0;gallery.replaceChildren();
 for(const e of d.entries.slice(0,6)){if(e.blob){const url=URL.createObjectURL(e.blob);urls.push(url);const img=document.createElement('img');img.src=url;img.alt=e.id;gallery.append(img);}}
}
document.querySelector('#run')!.addEventListener('click',async()=>{
 try{
 output.textContent='実ブラウザーの保存先を検証中';
 const image=await(await fetch('/sample-thumbnail.jpg',{cache:'no-store'})).blob();
 const targets=newestPhotoTargets(rows);let s=await repo.reconcile('browser-test',targets,Date.now());
 for(const t of targets)await repo.put('browser-test',s.epoch,t,image);
 let d=await disk();check(d.entries.length===1000,'1,000枚保存');
 const oldEpoch=s.epoch;
 for(let round=0;round<10;round++){
  const next=[...targets.slice(20),...Array.from({length:20},(_,i)=>({id:`replacement-${round}-${i}`,version:'v'}))];
  s=await repo.reconcile('browser-test',next,Date.now()+round+1);
  for(const t of next.slice(-20))await repo.put('browser-test',s.epoch,t,image);
  d=await disk();check(d.entries.length===1000&&d.meta.bytes===image.size*1000&&d.meta.bytes<=LIST_PHOTO_BYTES,`入替${round+1}回目：1,000枚を維持`);
 }
 check(!(await repo.put('browser-test',oldEpoch,targets[0],image)),'削除後に遅れて到着した写真を保存しない');
 check((await repo.get('browser-test',targets[0]))===null,'対象外の写真は保存先から読めない');
 await show();log('完了。ページを再読み込みして「保存内容を確認」で保持を確認できます。');
 }catch(e){log('FAIL '+String(e));}
});
document.querySelector('#inspect')!.addEventListener('click',()=>{void show();});
document.querySelector('#clear')!.addEventListener('click',async()=>{await repo.clear('browser-test');await show();check((await disk()).entries.length===0,'ログアウト相当の写真全削除');});
document.querySelector('#failure')!.addEventListener('click',async()=>{
 let additions=0;const c=new ListPhotoCache({...repo,reconcile:async()=>{throw Error('PHOTO_STORAGE_TRANSACTION');},put:async()=>{additions++;return true;}},'failed',async()=>[],async()=>new Blob());
 await c.select(rows,Date.now());c.setActive(true);check(!!c.status().warning&&additions===0,'削除/整理失敗時に追加保存を停止');await c.clearOnLogout();
});
