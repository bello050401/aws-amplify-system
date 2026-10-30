import {restageInventoryFields,type RestageLot} from './restage';
import {procurementPurchasePrice} from './pricing';
import {ledgerFields,type RestageLedger,type RestageDefaults} from './restageTotals';
export {restageLedger,ledgerFields} from './restageTotals';
export type {RestageLedger,RestageDefaults} from './restageTotals';

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
  if(receipt.rounding==='CEILING'&&receipt.multiplier==='1.188'){
    const divisor=1000*(lot.isBundle?lot.quantity:1),oldPrice=Math.floor((lot.hammerPrice*1188+divisor-1)/divisor);
    const price=procurementPurchasePrice('RESTAGE',lot.hammerPrice,lot.quantity,lot.isBundle);
    const edited=new Set(Array.isArray(custom.__belloEditedFields)?custom.__belloEditedFields:[]);
    if(row.purchasePrice!==price){
      if(row.purchasePrice!==oldPrice||edited.has('purchasePrice'))throw Error('購入価格が手動で変更されています。商品ページで確認してください。');
      changes.purchasePrice=price;
    }
    const memo=restageInventoryFields({...lot,purchasePrice:price}).adminMemo;
    if(row.adminMemo===memo.replace('四捨五入','切り上げ'))changes.adminMemo=memo;
    changes.customFields={...custom,__restageImport:{...receipt,rounding:'HALF_UP'}};
  }
  if(JSON.stringify(receipt.ledger)!==JSON.stringify(ledger)){
    const before=receipt.ledger?ledgerFields(receipt.ledger):{purchaseQuantity:lot.quantity,usedGoodsItemType:lot.itemType,dailyPurchaseTotal:null};
    for(const [key,value] of Object.entries(ledgerFields(ledger))){
      if(row[key]!==undefined&&row[key]!==null&&row[key]!==''&&row[key]!==before[key as keyof typeof before]&&row[key]!==value)throw Error('古物台帳が別の内容に変更されています。商品ページで確認してください。');
      if(row[key]!==value)changes[key]=value;
    }
    const next=(changes.customFields??custom) as Record<string,unknown>;
    changes.customFields={...next,__restageImport:{...((next.__restageImport??receipt) as Record<string,unknown>),ledger}};
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
