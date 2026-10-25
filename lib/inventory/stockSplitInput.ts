export interface StockSplitRequest {
 mutationId:string; inventoryId:string; expectedUpdatedAt:string; quantity:number;
 sourceName?:string; splitName?:string;
 damageNotes:string; barcode:string; photos:{storageKey:string;type:'DAMAGE'}[];
}
export interface StockSplitResult {sourceId:string;splitId:string;remainingQuantity:number;splitQuantity:number;updatedAt:string}
export class StockSplitError extends Error {
 constructor(public code:'INVALID'|'CONFLICT'|'UNCONFIRMED'|'FORBIDDEN',message:string){super(message);}
}
export function validateStockSplit(r:StockSplitRequest,available?:number,owner?:string) {
 const fail=(message:string):never=>{throw new StockSplitError('INVALID',message);};
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!r||!uuid.test(r.mutationId)||!uuid.test(r.inventoryId)||!Number.isFinite(Date.parse(r.expectedUpdatedAt)))fail('商品を開き直してください。');
 if(!Number.isSafeInteger(r.quantity)||r.quantity<1||r.quantity>2147483647)fail('数量は1以上の整数で入力してください。');
 for(const name of [r.sourceName,r.splitName])if(name!==undefined&&(typeof name!=='string'||!name.trim()||name.trim().length>2000))fail('それぞれの商品名を2000文字以内で入力してください。');
 if(available!==undefined&&(!Number.isSafeInteger(available)||r.quantity>available))fail('分ける数量が元の在庫数量を超えています。');
 if(typeof r.damageNotes!=='string'||r.damageNotes.length>10000)fail('メモは10000文字以内で入力してください。');
 if(typeof r.barcode!=='string'||r.barcode.length>256||/[\u0000-\u001f\u007f]/u.test(r.barcode))fail('バーコードの値を確認してください。');
 if(!Array.isArray(r.photos)||r.photos.length>20||r.photos.some(p=>!p||p.type!=='DAMAGE'||typeof p.storageKey!=='string'||!/^inventory\/mobile\/[a-z0-9-]+\/[a-f0-9-]{36}\/[a-f0-9]{64}\.jpg$/.test(p.storageKey)||(owner&&!p.storageKey.startsWith('inventory/mobile/'+owner+'/'))))fail('写真を選び直してください。');
 if(new Set(r.photos.map(p=>p.storageKey)).size!==r.photos.length)fail('同じ写真が重複しています。');
}
