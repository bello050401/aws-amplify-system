import type {ExternalProduct} from '../listing/econveni/manualSyncModel';
import type {EcChannel} from '../listing/ecManagement';
/** Immutable listing IDs are the only automatic repair key. Titles never authorize a link. */
export function uniqueSaleLink(products:ExternalProduct[],channel:EcChannel,listingId:string,inventoryId:string):ExternalProduct|null{
 if(!listingId)return null;
 const matches=products.filter(p=>p.channels[channel].listingId===listingId);
 if(matches.length!==1)return null;
 const p=matches[0];return p.inventoryMarker&&p.inventoryMarker!==inventoryId?null:p;
}
