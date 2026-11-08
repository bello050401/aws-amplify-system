"use server";
import {getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {getEcListingCatalogCore} from '@/lib/listing/ecCatalogCore';
export async function getEcListingCatalogAction(inventoryId?:string){
 return getEcListingCatalogCore(await getInventoryRole(),inventoryId);
}
