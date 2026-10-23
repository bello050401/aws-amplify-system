import type {RestageLot} from './restage';

export type RestageLedger = {version:2;date:string;lotCount:number;quantity:number;itemTypes:string;hammerTotal:number;purchaseTotal:number};
export type RestageDefaults = {categoryId:string;locationId:string};
export function restageLedger(lots:RestageLot[]):RestageLedger {
  if(!lots.length || new Set(lots.map(x=>x.date)).size!==1 || new Set(lots.map(x=>x.goodsId)).size!==lots.length) throw Error('開催日ごとの落札集計を確認できません。');
  const counts=new Map<string,number>();let quantity=0,hammerTotal=0;
  for(const lot of lots){
    quantity+=lot.quantity;counts.set(lot.itemType,(counts.get(lot.itemType)??0)+lot.quantity);
    hammerTotal+=lot.hammerPrice*(lot.isBundle?1:lot.quantity);
  }
  const purchaseTotal=Math.floor((hammerTotal*1188+999)/1000);
  if(!Number.isSafeInteger(hammerTotal*1188)||purchaseTotal>2147483647||quantity>2147483647)throw Error('開催日の仕入れ合計が入力上限を超えています。');
  const itemTypes=['テーブル','椅子','棚','照明','その他'].filter(k=>counts.has(k)).map(k=>`${k} ${counts.get(k)}点`).join('、');
  return {version:2,date:lots[0].date,lotCount:lots.length,quantity,itemTypes,hammerTotal,purchaseTotal};
}
export function ledgerFields(ledger:RestageLedger){return {purchaseQuantity:ledger.quantity,usedGoodsItemType:ledger.itemTypes,dailyPurchaseTotal:ledger.purchaseTotal};}
export function resolveRestageDefaults(categories:{id:string;name:string}[],locations:{id:string;name:string}[]):RestageDefaults {
  const category=categories.filter(x=>x.name==='補修待ち'),location=locations.filter(x=>x.name==='所沢事務所');
  if(category.length!==1||location.length!==1)throw Error('取込先の「補修待ち」「所沢事務所」をマスタで確認してください。');
  return {categoryId:category[0].id,locationId:location[0].id};
}
export function importCustom(row:Record<string,unknown>){return typeof row.customFields==='string'?JSON.parse(row.customFields):row.customFields??{};}
export function restageSupplement(row:Record<string,unknown>,lot:RestageLot,ledger:RestageLedger,defaults:RestageDefaults){
  const custom=importCustom(row),receipt=custom.__restageImport;
  if(receipt?.date!==lot.date||receipt.goodsId!==lot.goodsId)throw Error('登録先の商品が一致しません。');
  const changes:Record<string,unknown>={};
  if(JSON.stringify(receipt.ledger)!==JSON.stringify(ledger)){
    const before=receipt.ledger?ledgerFields(receipt.ledger):{purchaseQuantity:lot.quantity,usedGoodsItemType:lot.itemType,dailyPurchaseTotal:null};
    for(const [key,value] of Object.entries(ledgerFields(ledger))){
      if(row[key]!==undefined&&row[key]!==null&&row[key]!==''&&row[key]!==before[key as keyof typeof before]&&row[key]!==value)throw Error('古物台帳が別の内容に変更されています。商品ページで確認してください。');
      if(row[key]!==value)changes[key]=value;
    }
    changes.customFields={...custom,__restageImport:{...receipt,ledger}};
  }
  // Defaults are applied once; a later deliberate clearing must survive re-fetch.
  if(!receipt.defaults){
    const edited=new Set(Array.isArray(custom.__belloEditedFields)?custom.__belloEditedFields:[]);
    if(!row.locationId&&!edited.has('locationId'))changes.locationId=defaults.locationId;
    if(!row.categoryId&&(!Array.isArray(row.categoryIds)||row.categoryIds.length===0)&&!edited.has('categoryId')&&!edited.has('categoryIds')){changes.categoryId=defaults.categoryId;changes.categoryIds=[defaults.categoryId];}
    const next=(changes.customFields??custom) as Record<string,unknown>;
    const nextReceipt=(next.__restageImport??receipt) as Record<string,unknown>;
    changes.customFields={...next,__restageImport:{...nextReceipt,defaults}};
  }
  return changes;
}
