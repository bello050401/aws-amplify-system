import type {InventoryItem,InventoryThumbnail} from './inventory';
import {inventoryComparator} from '../../../lib/inventory/searchSort';

export const LIST_PHOTO_COUNT=1000;
export const LIST_PHOTO_BYTES=20*1024*1024;
export const LIST_PHOTO_SINGLE_BYTES=128*1024;
export type PhotoTarget={id:string;version:string};
export type PhotoCacheState={epoch:number;known:Record<string,string>;count:number;bytes:number};
export interface PhotoRepository {
 reconcile(owner:string,targets:PhotoTarget[],observedAt:number):Promise<PhotoCacheState>;
 get(owner:string,target:PhotoTarget):Promise<Blob|null>;
 put(owner:string,epoch:number,target:PhotoTarget,blob:Blob|null):Promise<boolean>;
 clear(owner:string):Promise<void>;
}
export function newestPhotoTargets(items:InventoryItem[]):PhotoTarget[]{
 const compare=inventoryComparator({field:'updatedAt',direction:'desc'},new Map());
 return items.map(a=>({...a,sourceInventoryId:a.displayId&&/^\d+$/.test(a.displayId)?a.displayId:undefined})).sort(compare)
  .slice(0,LIST_PHOTO_COUNT).map(i=>({id:i.id,version:i.updatedAt}));
}

/** One bounded, disposable photo store. It never contains originals or inventory writes. */
export class ListPhotoCache {
 private wanted=new Map<string,string>();
 private state:PhotoCacheState|null=null;
 private listeners=new Set<()=>void>();
 private generation=0;
 private stopped=false;
 private running=false;
 private reconciling=false;
 private active=false;
 private busy=false;
 private visibleDownloads=0;
 private quietUntil=0;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private controller:AbortController|null=null;
 private queue:Promise<void>=Promise.resolve();
 private hints=new Map<string,InventoryThumbnail>();
 private failures=new Map<string,number>();
 private skipped=new Map<string,string>();
 private signature='';
 private warning:string|null=null;
 constructor(private repo:PhotoRepository,private owner:string,private load:(ids:string[])=>Promise<InventoryThumbnail[]>,private download:(url:string,signal:AbortSignal)=>Promise<Blob>,private now=()=>Date.now()){}
 subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private emit(){this.listeners.forEach(fn=>fn());}
 status(){return {count:this.state?.count??0,bytes:this.state?.bytes??0,warning:this.warning};}
 has(item:{id:string;updatedAt:string}){return this.state?.known[item.id]===item.updatedAt&&this.wanted.get(item.id)===item.updatedAt;}
 async read(item:{id:string;updatedAt:string}){return this.has(item)?this.repo.get(this.owner,{id:item.id,version:item.updatedAt}):null;}
 async select(items:InventoryItem[],observedAt:number){
  if(this.stopped)return;
  const targets=newestPhotoTargets(items),signature=JSON.stringify(targets);
  if(signature===this.signature&&!this.warning)return;
  this.signature=signature;this.wanted=new Map(targets.map(t=>[t.id,t.version]));
  const generation=++this.generation;this.controller?.abort();this.reconciling=true;this.emit();
  const task=this.queue.then(async()=>{
   if(this.stopped||generation!==this.generation)return;
   try{
    const state=await this.repo.reconcile(this.owner,targets,observedAt);
    if(this.stopped||generation!==this.generation)return;
    this.state=state;this.reconciling=false;this.warning=null;this.failures.clear();this.hints.clear();
    for(const [id,version] of this.skipped)if(this.wanted.get(id)!==version)this.skipped.delete(id);
    this.emit();this.schedule();
   }catch{if(!this.stopped&&generation===this.generation){this.reconciling=false;this.warning='写真の端末保存を一時停止しています。再読み込みで再確認します。';this.emit();}}
  });
  this.queue=task.catch(()=>{});await task;
 }
 setActive(value:boolean){this.active=value;if(!value){clearTimeout(this.timer);this.timer=undefined;this.controller?.abort();}else this.schedule();}
 foregroundBusy(value:boolean){this.busy=value;if(value)this.defer();else this.schedule();}
 beginVisible(){this.visibleDownloads++;this.defer();return()=>{this.visibleDownloads=Math.max(0,this.visibleDownloads-1);this.schedule();};}
 async rememberVisible(item:{id:string;updatedAt:string},blob:Blob){
  if(this.stopped||this.reconciling||!this.state||this.warning||this.has(item)||this.wanted.get(item.id)!==item.updatedAt)return;
  const generation=this.generation,epoch=this.state.epoch;
  try{
   if(await this.repo.put(this.owner,epoch,{id:item.id,version:item.updatedAt},blob)){
    if(this.stopped||generation!==this.generation||this.has(item))return;
    this.state!.known[item.id]=item.updatedAt;this.state!.count++;this.state!.bytes+=blob.size;this.failures.delete(item.id);this.hints.delete(item.id);this.emit();
   }
  }catch{if(!this.stopped&&generation===this.generation){this.warning='写真の端末保存を一時停止しています。再読み込みで再確認します。';this.emit();}}
 }
 defer(){this.quietUntil=this.now()+1200;this.controller?.abort();this.schedule();}
 hint(images:InventoryThumbnail[]){
  for(const image of images)if(this.wanted.get(image.id)===image.updatedAt&&!this.has(image))this.hints.set(image.id,image);
  this.schedule();
 }
 private schedule(delay=300){
  if(this.stopped||!this.active||!this.state||this.reconciling||this.warning||this.timer)return;
  this.timer=setTimeout(()=>{this.timer=undefined;void this.pump();},Math.max(delay,this.quietUntil-this.now()));
 }
 private async pump(){
  if(this.running||!this.active||this.stopped||!this.state||this.reconciling||this.warning)return;
  if(this.busy||this.visibleDownloads||this.now()<this.quietUntil){this.schedule();return;}
  const wanted=[...this.wanted].filter(([id,v])=>this.state!.known[id]!==v&&this.skipped.get(id)!==v&&(this.failures.get(id)??0)<=this.now());
  if(!wanted.length){if(this.failures.size)this.schedule(Math.max(1000,Math.min(...this.failures.values())-this.now()));return;}
  this.running=true;const generation=this.generation,epoch=this.state.epoch;
  const abort=new AbortController();this.controller=abort;
  try{
   const hinted=wanted.filter(([id])=>this.hints.has(id));
   const batch=(hinted.length?hinted:wanted).slice(0,12);
   const rows=hinted.length?batch.map(([id])=>this.hints.get(id)!):await this.load(batch.map(([id])=>id));
   if(this.stopped||generation!==this.generation||abort.signal.aborted)return;
   // One download at a time. Input/scroll/visibility changes cancel background work.
   for(const [id,version] of batch){
    if(this.busy||this.visibleDownloads||abort.signal.aborted||!this.active||generation!==this.generation)break;
    const image=rows.find(r=>r.id===id&&r.updatedAt===version);
    if(!image){this.failures.set(id,this.now()+60000);continue;}
    try{
     const blob=image.thumbnailUrl?await this.download(image.thumbnailUrl,abort.signal):null;
     if(abort.signal.aborted||this.stopped||generation!==this.generation)break;
     const saved=await this.repo.put(this.owner,epoch,{id,version},blob);
     if(this.stopped||generation!==this.generation)break;
     if(saved){this.state!.known[id]=version;this.state!.count+=blob?1:0;this.state!.bytes+=blob?.size??0;this.failures.delete(id);this.hints.delete(id);this.emit();}
     else{this.skipped.set(id,version);this.failures.delete(id);this.hints.delete(id);}
    }catch(error){
     if(abort.signal.aborted)break;
     // Storage failures stop additions; network/invalid images only retry later.
     if(error instanceof Error&&error.message.startsWith('PHOTO_STORAGE')){this.warning='写真の端末保存を一時停止しています。再読み込みで再確認します。';this.emit();break;}
     if(error instanceof Error&&['PHOTO_NOT_THUMBNAIL','PHOTO_TOO_LARGE'].includes(error.message)){this.skipped.set(id,version);this.failures.delete(id);this.hints.delete(id);continue;}
     this.failures.set(id,this.now()+60000);
    }
   }
  }catch{if(!abort.signal.aborted)for(const [id] of wanted.slice(0,12))this.failures.set(id,this.now()+60000);}
  finally{this.running=false;if(this.controller===abort)this.controller=null;this.schedule();}
 }
 async clearOnLogout(){
  this.stopped=true;this.generation++;clearTimeout(this.timer);this.controller?.abort();this.state=null;this.wanted.clear();this.emit();
  await this.queue;await this.repo.clear(this.owner);
 }
}
