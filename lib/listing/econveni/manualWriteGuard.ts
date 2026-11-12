import 'server-only';
import {econveniStore} from './runtimeStore';
import type {EcChannel} from '../ecManagement';
import type {ManualLink} from './manualSyncModel';
import {selectManualLink} from './manualSyncModel';
import {readManualSync} from './manualSync';
export const MANUAL_READ_ONLY_MESSAGE='eコンビニの既存商品と連携済みです。重複出品を防ぐため、新しい商品登録・商品情報の上書きは行いません。出品停止はEC出品画面から販売先を選んで確認してください。';
/** A read-only association must never make a legacy command target a different listing or create a duplicate. */
export async function manualWriteRestriction(id:string,channel?:EcChannel,nativeListingId?:string|null):Promise<string|null>{
 const data=await readManualSync(id);
 let link:ManualLink|undefined;try{link=selectManualLink(data,id,channel);}catch(e){return (e as Error).message;}
 if(!link||link.disabled)return null;
 const remote=data.snapshot?.products.find(p=>p.productId===link.productId);
 if(!remote)return MANUAL_READ_ONLY_MESSAGE;
 if(channel==='BASE')return nativeListingId&&nativeListingId===remote.channels.BASE.listingId?null:MANUAL_READ_ONLY_MESSAGE;
 const state=await econveniStore(id).read();
 if(state?.save.productId!==link.productId)return MANUAL_READ_ONLY_MESSAGE;
 if(channel&&nativeListingId!==undefined&&nativeListingId!==remote.channels[channel].listingId)return MANUAL_READ_ONLY_MESSAGE;
 if(channel&&state.channels[channel].listingId!==remote.channels[channel].listingId)return MANUAL_READ_ONLY_MESSAGE;
 return null;
}
