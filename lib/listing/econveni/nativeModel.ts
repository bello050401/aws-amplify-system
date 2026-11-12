import type {EcChannel} from '../ecManagement';
import type {ExternalProduct} from './manualSyncModel';
export type NativeOperation='PUBLISH'|'CLEAR'|'STOP';
export const NATIVE_LABEL={PUBLISH:'出',CLEAR:'消',STOP:'止'} as const;
export const NATIVE_DESCRIPTION={PUBLISH:'eコンビニに保存した内容で出品',CLEAR:'eコンビニの出品番号を解除（ECの商品は残す）',STOP:'販売先の出品を終了'} as const;
export type NativeRequest={inventoryId:string;productId:string;channel:EcChannel;operation:NativeOperation};
export type NativeJob=NativeRequest & {id:string;actor:string;title:string;state:'EC_NATIVE_ACTIVE'|'EC_NATIVE_DONE'|'EC_NATIVE_ATTENTION';phase:'QUEUED'|'SENDING'|'COMPLETE'|'ATTENTION';fingerprint:string;inventoryVersion:string;stockFingerprint?:string;before:ExternalProduct;nextAt:number;createdAt:string;updatedAt:string;attempts:number;reason?:string;terms:boolean;result?:ExternalProduct};
export function nativeAllowed(request:NativeRequest,remote:ExternalProduct,item:{quantity?:number;saleEndDate?:string;isDeleted?:boolean;deletedAt?:string;listingPartition?:string},protectedSale:boolean):string|null{
 if(!['BASE','YAHOO','MERCARI_SHOPS'].includes(request.channel)||!['PUBLISH','CLEAR','STOP'].includes(request.operation))return '操作を確認してください。';
 if(item.isDeleted||item.deletedAt||item.listingPartition==='MERGED')return '削除・統合済みの商品です。';
 const state=remote.channels[request.channel];
 if(request.operation==='PUBLISH'){
  if(item.saleEndDate||!(Number(item.quantity)>0)||protectedSale)return '売却済みの商品ページは再出品できません。残っている在庫を選んでください。';
  if(state.state==='ACTIVE')return '既に出品中です。';
  if(state.listingId)return '古い出品番号が残っています。先に「消」で番号を解除してください。';
  if(state.state==='EXCLUDED')return 'eコンビニで出品対象外になっています。';
  if(remote.quantity<1||remote.quantity>Number(item.quantity))return 'eコンビニの数量を現在の在庫数に合わせてください。';
 }
 if(request.operation==='CLEAR'&&!state.listingId)return '解除する出品番号がありません。';
 if(request.operation==='STOP'&&protectedSale)return '売れた販売先の商品ページは保護されています。';
 if(request.operation==='STOP'&&(!state.listingId||state.state!=='ACTIVE'))return '現在、出品中ではありません。';
 return null;
}
export function nativeResultMatches(job:Pick<NativeJob,'channel'|'operation'|'before'>,after:ExternalProduct){
 if(after.productId!==job.before.productId)return false;
 const b=job.before.channels[job.channel],s=after.channels[job.channel];
 if(job.operation==='PUBLISH')return s.state==='ACTIVE'&&!!s.listingId&&s.listingId!==b.listingId;
 if(job.operation==='CLEAR')return s.state==='INACTIVE'&&!s.listingId;
 return s.state==='INACTIVE'&&(!s.listingId||s.listingId===b.listingId);
}
