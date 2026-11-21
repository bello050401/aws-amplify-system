import type {EcChannel} from '../ecManagement';
export type SaleBindingErrorCode='SALE_BINDING_LISTING_CHANGED'|'SALE_BINDING_INVENTORY_CHANGED'|'SALE_BINDING_PENDING'|'SALE_BINDING_INVENTORY_UNAVAILABLE';
/** Expected identity holds are finite structured facts, never a remote error message. */
export class SaleBindingError extends Error{
 readonly name='SaleBindingError';
 constructor(public readonly code:SaleBindingErrorCode,public readonly channel?:EcChannel){
  super(code==='SALE_BINDING_LISTING_CHANGED'?'出品IDが変わっています。eコンビニ連携で写真と商品を確認してください。':code==='SALE_BINDING_INVENTORY_CHANGED'?'eコンビニに別の在庫番号が登録されています。':code==='SALE_BINDING_PENDING'?'eコンビニの前回の処理結果を先に確認してください。':'在庫を確認できません。');
 }
}
