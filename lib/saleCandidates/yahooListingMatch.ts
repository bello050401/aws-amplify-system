import type {EconveniWorkflow} from '../listing/econveni/workflowStore';
import type {ManualSyncData} from '../listing/econveni/manualSyncModel';
/** Exact identifiers from confirmed local bindings only; titles never imply a binding. */
export function collectYahooInventoryIds(auctionId:string,legacy:{inventoryId?:string;auctionId?:string;deletedAt?:string|null}[],workflows:EconveniWorkflow[],manual:ManualSyncData){
 const ids=new Set<string>();
 for(const row of legacy)if(!row.deletedAt&&row.auctionId===auctionId&&row.inventoryId)ids.add(row.inventoryId);
 for(const row of workflows)if(row.channels.YAHOO?.listingId===auctionId)ids.add(row.inventoryId);
 const products=new Map(manual.snapshot?.products.map(p=>[p.productId,p])||[]);
 for(const link of manual.links){
  if(link.disabled)continue;
  if(link.baseline.YAHOO.listingId===auctionId||products.get(link.productId)?.channels.YAHOO.listingId===auctionId)ids.add(link.inventoryId);
 }
 return [...ids];
}
