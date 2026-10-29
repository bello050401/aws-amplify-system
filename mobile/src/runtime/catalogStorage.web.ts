import type {KeyValueStore} from '../domain/snapshot';

// IndexedDB performs disk I/O asynchronously, unlike localStorage on every search keystroke.
// No API responses or images are placed in a service-worker cache.
const DATABASE='bello-search-v2';
let opening:Promise<IDBDatabase>|null=null;
function database():Promise<IDBDatabase>{
 if(opening)return opening;
 opening=new Promise<IDBDatabase>((resolve,reject)=>{
  if(typeof indexedDB==='undefined'){reject(Error('STORAGE_UNAVAILABLE'));return;}
  const request=indexedDB.open(DATABASE,1);
  let abandoned=false;
  const timer=setTimeout(()=>{abandoned=true;reject(Error('STORAGE_TIMEOUT'));},3000);
  request.onupgradeneeded=()=>{request.result.createObjectStore('values');};
  request.onerror=()=>{clearTimeout(timer);reject(request.error);};
  request.onblocked=()=>{abandoned=true;clearTimeout(timer);reject(Error('STORAGE_BLOCKED'));};
  request.onsuccess=()=>{clearTimeout(timer);const db=request.result;if(abandoned){db.close();return;}db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
 }).catch(error=>{opening=null;throw error;});
 return opening;
}
async function run<T>(mode:IDBTransactionMode,operation:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
 const db=await database();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction('values',mode),request=operation(tx.objectStore('values'));
  const timer=setTimeout(()=>{try{tx.abort();}catch{}reject(Error('STORAGE_TIMEOUT'));},3000);
  tx.oncomplete=()=>{clearTimeout(timer);resolve(request.result);};
  tx.onabort=tx.onerror=()=>{clearTimeout(timer);reject(tx.error??Error('STORAGE_FAILED'));};
 });
}
export const catalogStorage:KeyValueStore={
 getItem:async key=>(await run('readonly',s=>s.get(key)))??null,
 setItem:async(key,value)=>{await run('readwrite',s=>{
  // This device keeps only its current account's search catalogue, not abandoned accounts.
  const cursor=s.openKeyCursor();cursor.onsuccess=()=>{const c=cursor.result;if(c){if(c.key!==key)s.delete(c.key);c.continue();}};
  return s.put(value,key);
 });},
 removeItem:async key=>{await run('readwrite',s=>s.delete(key));},
};
