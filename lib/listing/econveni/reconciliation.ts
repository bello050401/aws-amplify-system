import type { EconveniRemoteProduct, EconveniMarket } from "./httpSession";
import type { EconveniWorkflow } from "./workflowStore";
import { EconveniWorkflowError } from "./workflowStore";

/** A product excluded from batch operations may still be publicly listed.
 * Only an explicit market state on the immutable bound row settles an uncertain write.
 */
export function reconcileEconveniChannel(current:EconveniWorkflow, remote:EconveniRemoteProduct|null, channel:EconveniMarket, now=new Date().toISOString()):EconveniWorkflow {
  const previous=current.channels[channel];
  if(!["PENDING","VERIFY_REQUIRED"].includes(previous.state)) return current;
  if(!previous.operation || !previous.operationId) throw new EconveniWorkflowError("INVALID_TRANSITION");
  if(remote && remote.productId!==current.save.productId) throw new EconveniWorkflowError("INVALID_TRANSITION");
  const observed=remote?.channels[channel];
  const uncertain=()=>({...current,channels:{...current.channels,[channel]:{...previous,state:"VERIFY_REQUIRED" as const,errorCode:"REMOTE_RESULT_UNCONFIRMED"}}});
  if(!observed||observed.state==="EXCLUDED") return uncertain();
  if(previous.operation==="PUBLISH") {
    if(observed.state!=="ACTIVE"||!observed.listingId||!observed.listingUrl) return uncertain();
    // After a stopped item, only a new live listing ID can settle a re-publication.
    if(previous.remoteStatus==="INACTIVE"&&previous.listingId===observed.listingId) return uncertain();
    return {...current,channels:{...current.channels,[channel]:{...previous,state:"SUCCEEDED",remoteStatus:"ACTIVE",listingId:observed.listingId,listingUrl:observed.listingUrl,publishedAt:now,stopEffect:undefined,errorCode:undefined}}};
  }
  if(observed.state!=="INACTIVE" || observed.listingId && observed.listingId!==previous.listingId) return uncertain();
  return {...current,channels:{...current.channels,[channel]:{...previous,state:"SUCCEEDED",remoteStatus:"INACTIVE",stopEffect:channel==="MERCARI_SHOPS"?"REMOVED":"ENDED",stoppedAt:now,errorCode:undefined}}};
}
