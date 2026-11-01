import {NOT_MERGED_FILTER} from "@/lib/outbound/mergeInventory";
import {compareInventoryDateDesc} from "./productDates";
import {categoryFilter} from "./categories";
import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { MasterEntry } from "@/lib/inventory/masters";
import { isEcListingVisible } from "@/lib/listing/ecEligibility";
import { toListRow, type InventoryListRow } from "@/lib/inventory/queries";
import {inventoryVerifiedReadSession} from './mutationSession';
import {inventoryDdb,inventoryTable} from './categoryPersistence';
import {readEcEligibleRecords} from './ecEligibleRead';

/** Multiple categories use Inventory.categoryIds; categoryId remains a legacy fallback. */
export interface EcEligibleInventoryResult {
  items: InventoryListRow[];
  /** 引いた対象カテゴリの数。 */
  queriedCategories: number;
  /** カテゴリ未設定のため対象外になった件数は数えられないので、その旨を示す。 */
  uncategorizedExcluded: true;
}

/** Read once for all eligible categories to avoid one full table scan per category. */
export async function listEcEligibleInventory(categories: MasterEntry[]): Promise<EcEligibleInventoryResult> {
 const eligible=categories.filter(c=>isEcListingVisible(c.name));
 if(!eligible.length)return {items:[],queriedCategories:0,uncategorizedExcluded:true};
 // Verify the token signature and role before server-side IAM reads. Keep
 // AppSync authorization as the fallback when that session/index is absent.
 if(await inventoryVerifiedReadSession()) {
  const current=await readEcEligibleRecords(inventoryDdb,inventoryTable('Inventory'),eligible.map(c=>c.id));
  if(current!==null) {
   const items=current.map(row=>toListRow(row as never));
   items.sort(compareInventoryDateDesc);
   return {items,queriedCategories:eligible.length,uncategorizedExcluded:true};
  }
 }
 const items:InventoryListRow[]=[];let nextToken:string|null|undefined;
 do {
  const {data,nextToken:nt,errors}=await serverDataClient.models.Inventory.list({filter:{and:[NOT_MERGED_FILTER,{deletedAt:{attributeExists:false}},{or:eligible.map(c=>categoryFilter(c.id))}]},limit:1000,nextToken:nextToken??undefined,...inventoryAuthMode});
  if(errors)throw new Error('在庫の取得に失敗しました: '+errors.map(e=>e.message).join('; '));
  items.push(...data.filter(row=>!row.deletedAt&&row.listingPartition!=='MERGED').map(row=>toListRow(row as never)));nextToken=nt;
 }while(nextToken);
 items.sort(compareInventoryDateDesc);
 return {items,queriedCategories:eligible.length,uncategorizedExcluded:true};
}
