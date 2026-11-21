import 'server-only';
import {refreshSaleBinding} from '../listing/econveni/saleAdjustment';
import {linkExternalProduct,readManualSync,refreshManualSync,productFingerprint} from '../listing/econveni/manualSync';
import type {EcChannel} from '../listing/ecManagement';
import {uniqueSaleLink} from './saleBindingPolicy';
/** Metadata repair only; no publication or quantity change. Always read the live product before selling. */
export async function ensureAutomaticSaleBinding(inventoryId:string,channel:EcChannel,listingId:string,actor:string){
 let remote=await refreshSaleBinding(inventoryId);
 if(!remote){
  let data=await readManualSync();
  if(!data.snapshot||Date.now()-Date.parse(data.snapshot.checkedAt)>30*60000)data=await refreshManualSync();
  const snapshot=data.snapshot,match=uniqueSaleLink(snapshot?.products??[],channel,listingId,inventoryId);
  if(!snapshot||!match)return false;
  await linkExternalProduct({inventoryId,productId:match.productId,version:snapshot.version,fingerprint:productFingerprint(match),confirmed:true},actor);
  remote=await refreshSaleBinding(inventoryId);
 }
 return !!remote&&remote.channels[channel].listingId===listingId&&(!remote.inventoryMarker||remote.inventoryMarker===inventoryId);
}
