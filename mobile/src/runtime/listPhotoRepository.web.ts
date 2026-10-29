import {LIST_PHOTO_BYTES,LIST_PHOTO_COUNT,LIST_PHOTO_SINGLE_BYTES,type PhotoRepository,type PhotoTarget,type PhotoCacheState} from '../domain/listPhotoCache';

const DB='bello-list-photos-v1';
type Meta={owner:string;epoch:number;observedAt:number;allowed:Record<string,string>;bytes:number;count:number};
type Entry={id:string;version:string;blob:Blob|null};
let opening:Promise<IDBDatabase>|null=null;
function database(){
 if(opening)return opening;
 opening=new Promise<IDBDatabase>((resolve,reject)=>{
  if(typeof indexedDB==='undefined'){reject(Error('PHOTO_STORAGE_UNAVAILABLE'));return;}
  const request=indexedDB.open(DB,1);let abandoned=false;
  const timeout=setTimeout(()=>{abandoned=true;reject(Error('PHOTO_STORAGE_TIMEOUT'));},4000);
  request.onupgradeneeded=()=>{request.result.createObjectStore('meta');request.result.createObjectStore('images',{keyPath:'id'});};
  request.onerror=request.onblocked=()=>{abandoned=true;clearTimeout(timeout);reject(Error('PHOTO_STORAGE_OPEN'));};
  request.onsuccess=()=>{clearTimeout(timeout);const db=request.result;if(abandoned){db.close();return;}db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
 }).catch(error=>{opening=null;throw error;});return opening;
}
async function transaction<T>(mode:IDBTransactionMode,work:(meta:IDBObjectStore,images:IDBObjectStore,result:(value:T)=>void)=>void):Promise<T>{
 const db=await database();return new Promise((resolve,reject)=>{
  const tx=db.transaction(['meta','images'],mode);let result:T;
  const timeout=setTimeout(()=>{try{tx.abort();}catch{}reject(Error('PHOTO_STORAGE_TIMEOUT'));},5000);
  tx.oncomplete=()=>{clearTimeout(timeout);resolve(result);};
  tx.onabort=tx.onerror=()=>{clearTimeout(timeout);reject(Error('PHOTO_STORAGE_TRANSACTION'));};
  try{work(tx.objectStore('meta'),tx.objectStore('images'),value=>{result=value;});}catch{tx.abort();}
 });
}
export const listPhotoRepository:PhotoRepository={
 async reconcile(owner,targets,observedAt){
  if(targets.length>LIST_PHOTO_COUNT||new Set(targets.map(t=>t.id)).size!==targets.length)throw Error('PHOTO_STORAGE_TARGETS');
  return transaction<PhotoCacheState>('readwrite',(meta,images,done)=>{
   const req=meta.get('current');req.onsuccess=()=>{
    const old=req.result as Meta|undefined;
    // A stale tab cannot bring back an older selection after a newer catalogue was applied.
    if(old?.owner===owner&&old.observedAt>observedAt){throwTransaction(meta);return;}
    const allowed=Object.fromEntries(targets.map(t=>[t.id,t.version]));
    const next:Meta={owner,allowed,observedAt,epoch:(old?.epoch??0)+1,bytes:0,count:0};
    const known:Record<string,string>={};
    const cursor=images.openCursor();cursor.onsuccess=()=>{
     const c=cursor.result;
     if(!c){meta.put(next,'current');done({epoch:next.epoch,known,count:next.count,bytes:next.bytes});return;}
     const entry=c.value as Entry,valid=old?.owner===owner&&allowed[entry.id]===entry.version&&(entry.blob===null||entry.blob instanceof Blob&&entry.blob.size<=LIST_PHOTO_SINGLE_BYTES&&entry.blob.type==='image/jpeg');
     if(!valid||next.bytes+(entry.blob?.size??0)>LIST_PHOTO_BYTES)c.delete();
     else{known[entry.id]=entry.version;next.bytes+=entry.blob?.size??0;if(entry.blob)next.count++;}
     c.continue();
    };
   };
  });
 },
 async get(owner,target){return transaction<Blob|null>('readonly',(meta,images,done)=>{
  const req=meta.get('current');req.onsuccess=()=>{
   const m=req.result as Meta|undefined;if(m?.owner!==owner||m.allowed[target.id]!==target.version){done(null);return;}
   const image=images.get(target.id);image.onsuccess=()=>{const entry=image.result as Entry|undefined;done(entry?.version===target.version?entry.blob:null);};
  };
 });},
 async put(owner,epoch,target,blob){
  if(blob&&(blob.size>LIST_PHOTO_SINGLE_BYTES||blob.type!=='image/jpeg'))return false;
  return transaction<boolean>('readwrite',(meta,images,done)=>{
   const req=meta.get('current');req.onsuccess=()=>{
    const m=req.result as Meta|undefined;
    if(m?.owner!==owner||m.epoch!==epoch||m.allowed[target.id]!==target.version){done(false);return;}
    const old=images.get(target.id);old.onsuccess=()=>{
     const previous=old.result as Entry|undefined;
     const bytes=m.bytes-(previous?.blob?.size??0)+(blob?.size??0),count=m.count-(previous?.blob?1:0)+(blob?1:0);
     if(bytes>LIST_PHOTO_BYTES||count>LIST_PHOTO_COUNT){done(false);return;}
     images.put({id:target.id,version:target.version,blob});meta.put({...m,bytes,count},'current');done(true);
    };
   };
  });
 },
 async clear(owner){await transaction<void>('readwrite',(meta,images,done)=>{
  const req=meta.get('current');req.onsuccess=()=>{if(req.result?.owner===owner){images.clear();meta.put({owner:'',allowed:{},epoch:req.result.epoch+1,observedAt:0,bytes:0,count:0},'current');}done();};
 });},
};
function throwTransaction(store:IDBObjectStore){store.transaction.abort();}
