const prefixes:Record<string,string>={'ベイス':'【BASE】','ヤフオク':'【ヤフオク】','メルカリSHOP':'【メルカリショップ】'};
/** Only the sold page receives this marker; the remaining page keeps its title. */
export function soldChannelTitle(name:string,market:string){
 const prefix=prefixes[market];
 return prefix?prefix+name.replace(/^(?:【(?:BASE|ヤフオク|メルカリショップ)】)+/,''):name;
}
/** Keep managed stock-title provenance valid when an outer sale marker is added. */
export function withSoldChannelTitle<T extends Record<string,unknown>>(row:T,market:string):T{
 const name=String(row.name??''),next=soldChannelTitle(name,market);if(next===name)return row;
 let custom:Record<string,unknown>;try{custom=typeof row.customFields==='string'?JSON.parse(row.customFields):{...(row.customFields as object??{})};}catch{return {...row,name:next};}
 const meta=custom.__belloStockTitle as Record<string,unknown>|undefined;
 if(meta?.version===1&&typeof meta.prefix==='string'&&name.startsWith(meta.prefix))custom.__belloStockTitle={...meta,salePrefix:prefixes[market],prefix:soldChannelTitle(meta.prefix,market)};
 return {...row,name:next,customFields:JSON.stringify(custom)};
}
