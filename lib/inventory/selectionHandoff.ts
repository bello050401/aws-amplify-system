const prefix='bello.inventory.selection.';
export function saveSelectionHandoff(ids:string[]){
 const key=crypto.randomUUID();
 // Bound storage and remove expired handoffs from this tab only.
 for(let i=sessionStorage.length-1;i>=0;i--){const k=sessionStorage.key(i)!;if(k.startsWith(prefix)){try{if(JSON.parse(sessionStorage.getItem(k)!).expires<Date.now())sessionStorage.removeItem(k);}catch{sessionStorage.removeItem(k);}}}
 const retained=Object.keys(sessionStorage).filter(k=>k.startsWith(prefix)).sort((a,b)=>JSON.parse(sessionStorage.getItem(a)!).expires-JSON.parse(sessionStorage.getItem(b)!).expires);
 for(const old of retained.slice(0,Math.max(0,retained.length-9)))sessionStorage.removeItem(old);
 if(!ids.length||ids.length>1000||ids.some(id=>!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))throw Error('選択対象を確認してください。');
 sessionStorage.setItem(prefix+key,JSON.stringify({ids:[...new Set(ids)],expires:Date.now()+30*60000}));return key;
}
export function readSelectionHandoff(key:string|null){
 if(!key)return [];
 try{const data=JSON.parse(sessionStorage.getItem(prefix+key)??'null');if(!data||data.expires<Date.now()||!Array.isArray(data.ids)||data.ids.length>1000||data.ids.some((id:unknown)=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))return [];return [...new Set<string>(data.ids)];}catch{return [];}
}
