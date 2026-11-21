import {SaleBindingError} from '@/lib/listing/econveni/saleBindingError';
import {EconveniHttpError} from '@/lib/listing/econveni/httpSession';
import {EconveniWorkflowError} from '@/lib/listing/econveni/workflowStore';
import {expectedDesktopBoundaryError} from './desktopJobModel';
const linkage={href:'/inventory/listings',label:'EC出品で紐付けを確認'};
const connection={href:'/inventory/settings?tab=econveni',label:'eコンビニの接続設定を確認'};
const labels={BASE:'BASE',YAHOO:'ヤフオク',MERCARI_SHOPS:'メルカリShops'};
/** A safe expected response never contains listing IDs, raw storage errors or retry instructions. */
export function desktopExpectedBoundary(error:unknown){
 if(error instanceof SaleBindingError){
  const channel=error.channel&&Object.hasOwn(labels,error.channel)?error.channel:undefined;
  return {error:error.code==='SALE_BINDING_LISTING_CHANGED'?`${channel?labels[channel]+'の':''}出品番号が保存済みの紐付けと一致しません。EC出品の「eコンビニ連携」で現在の写真・商品名・出品番号を確認してください。照合と売却の記録は保持しています。`:error.message,code:error.code,...(channel?{channel}:{}),action:linkage};
 }
 if(error instanceof EconveniHttpError&&['AUTH_REQUIRED','ACCESS_DENIED','ADDITIONAL_AUTH'].includes(error.code))return {error:'eコンビニへの接続・追加認証を確認してください。照合と売却の記録は保持しています。',code:'DESKTOP_ECONVENI_CONNECTION_REQUIRED',action:connection};
 if(error instanceof EconveniWorkflowError&&['BUSY_OR_STOPPED','WAIT_INTERVAL','VERIFY_REQUIRED'].includes(error.code))return {error:'別のEC操作または前回の結果が未確認です。変更を繰り返さず、EC出品と接続状態を確認してください。',code:'DESKTOP_ECONVENI_OPERATION_HELD',action:linkage};
 if(expectedDesktopBoundaryError(error))return {error:'状態または照合結果が一致しません。変更を繰り返さず、最新の在庫・注文・PC画面を確認してください。',code:/^DESKTOP_[A-Z_]+$/.test((error as Error).message)?(error as Error).message:'DESKTOP_STATE_CONFLICT'};
 return null;
}
