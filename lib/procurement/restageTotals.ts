import type {RestageLot} from './restageDraft';
import {procurementPurchasePrice} from './pricing';
export type RestageLedger = {version:2;rounding?:'HALF_UP';date:string;lotCount:number;quantity:number;itemTypes:string;hammerTotal:number;purchaseTotal:number};
export type RestageDefaults = {categoryId:string;locationId:string};
export function restageLedger(lots:RestageLot[]):RestageLedger {
  if(!lots.length || new Set(lots.map(x=>x.date)).size!==1 || new Set(lots.map(x=>x.goodsId)).size!==lots.length) throw Error('開催日ごとの落札集計を確認できません。');
  const counts=new Map<string,number>();let quantity=0,hammerTotal=0;
  for(const lot of lots){
    quantity+=lot.quantity;counts.set(lot.itemType,(counts.get(lot.itemType)??0)+lot.quantity);
    hammerTotal+=lot.hammerPrice*(lot.isBundle?1:lot.quantity);
  }
  const purchaseTotal=procurementPurchasePrice('RESTAGE',hammerTotal);
  if(!Number.isSafeInteger(hammerTotal*1188)||purchaseTotal>2147483647||quantity>2147483647)throw Error('開催日の仕入れ合計が入力上限を超えています。');
  const itemTypes=['テーブル','椅子','棚','照明','その他'].filter(k=>counts.has(k)).map(k=>`${k} ${counts.get(k)}点`).join('、');
  return {version:2,rounding:'HALF_UP',date:lots[0].date,lotCount:lots.length,quantity,itemTypes,hammerTotal,purchaseTotal};
}
export function ledgerFields(ledger:RestageLedger){return {purchaseQuantity:ledger.quantity,usedGoodsItemType:ledger.itemTypes,dailyPurchaseTotal:ledger.purchaseTotal};}
