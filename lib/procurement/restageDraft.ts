import {procurementPurchasePrice} from './pricing';
export type RestageLot = { goodsId:string; date:string; name:string; sourceQuantity:string; quantity:number; unit:string; hammerPrice:number; purchasePrice:number; isBundle:boolean; itemType:string; imageUrl:string; lotNumber:string };
export type RestageDraft = Omit<RestageLot,'quantity'|'hammerPrice'|'purchasePrice'> & {quantity:number|null;hammerPrice:number|null;purchasePrice:number|null;issues:string[]};
export type RestageEdit = Pick<RestageDraft,'goodsId'|'name'|'quantity'|'unit'|'hammerPrice'|'isBundle'|'itemType'>;
export const RESTAGE_ITEM_TYPES=['テーブル','椅子','棚','照明','その他'];
/** Rebuild prices from trusted source identity + explicitly editable fields. */
export function completeRestageDraft(source:RestageDraft,edit:RestageEdit=source):RestageLot {
  if(edit.goodsId!==source.goodsId||typeof edit.name!=='string'||!edit.name.trim()||edit.name.length>1000)throw Error('商品名を入力してください。');
  if(typeof edit.quantity!=='number'||!Number.isSafeInteger(edit.quantity)||edit.quantity<1||edit.quantity>100000)throw Error('数量を1以上の整数で入力してください。');
  if(typeof edit.hammerPrice!=='number'||!Number.isSafeInteger(edit.hammerPrice)||edit.hammerPrice<=0||edit.hammerPrice>100000000)throw Error('落札価格を1円以上の整数で入力してください。');
  if(typeof edit.isBundle!=='boolean'||!['台','脚','点','個','枚','本','組','セット','式'].includes(edit.unit)||!RESTAGE_ITEM_TYPES.includes(edit.itemType))throw Error('品目・単位・落札価格の扱いを確認してください。');
  return {goodsId:source.goodsId,date:source.date,sourceQuantity:source.sourceQuantity,lotNumber:source.lotNumber,imageUrl:source.imageUrl,name:edit.name.trim(),quantity:edit.quantity,unit:edit.unit,hammerPrice:edit.hammerPrice,isBundle:edit.isBundle,itemType:edit.itemType,purchasePrice:procurementPurchasePrice('RESTAGE',edit.hammerPrice,edit.quantity,edit.isBundle)};
}
