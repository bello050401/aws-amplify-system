import 'server-only';
import {manualLinkedStop} from './econveni/manualStop';
import {refreshSaleBinding} from './econveni/saleAdjustment';
import {manualWriteRestriction} from './econveni/manualWriteGuard';
import {getChannelListing} from './service';
import {nativeStop} from './econveni/nativeStop';
import {reviewBaseListing,executeBaseListing} from './base/manualLifecycle';
import type {EcChannel,EcReview} from './ecManagement';

/** Backend STOP-only operation. Caller must have an authenticated admin or private IAM worker boundary. */
export async function stopListing(id:string,channel:EcChannel,actor:string,token?:string):Promise<EcReview>{
 const base:EcReview={inventoryId:id,channel,operation:'STOP',title:'',status:'BLOCKED',message:'停止結果を確認できません。'};
 if(!actor||!['BASE','YAHOO','MERCARI_SHOPS'].includes(channel))return base;
 const manual=await manualLinkedStop(id,channel,actor,token);if(manual)return manual;
 if(!token)await refreshSaleBinding(id);
 const native=channel==='BASE'?await getChannelListing(id,'BASE'):null;
 const warning=await manualWriteRestriction(id,channel,channel==='BASE'?native?.externalListingId??null:undefined);
 if(warning)return {...base,message:warning};
 if(channel!=='BASE')return nativeStop(id,channel,actor,token);
 if(!token)return {...base,...await reviewBaseListing(id,'STOP')};
 const r=await executeBaseListing(id,'STOP',token);
 return {...base,status:r.ok?'DONE':'BLOCKED',message:r.message};
}
