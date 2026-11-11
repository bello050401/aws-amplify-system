"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { countActiveInventory } from "@/lib/inventory/inventoryPage";
import type { InventoryCursorListFilters } from "@/lib/inventory/inventoryCursorList";
import {listInventorySimpleSearch,listInventoryAdvanced,listCategories,listLocations,listStatuses,listCustomFieldDefinitions,type InventoryListFilters} from "@/lib/inventory/queries";
import {buildSearchFieldDefs,completeConditions,type AdvancedSearchQuery} from "@/lib/inventory/advancedSearch";

export async function getInventoryQuantityTotalAction(filters:InventoryListFilters,adv?:string):Promise<{ok:true;totalQuantity:number}|{ok:false}>{
  try{
    if(!await getInventoryRole())return {ok:false};
    if(!filters||typeof filters!=='object'||(filters.q!==undefined&&(typeof filters.q!=='string'||filters.q.length>500)))return {ok:false};
    if(filters.categoryIds&&(!Array.isArray(filters.categoryIds)||filters.categoryIds.length>100||filters.categoryIds.some(id=>typeof id!=='string')))return {ok:false};
    for(const id of [filters.locationId,filters.statusId])if(id!==undefined&&typeof id!=='string')return {ok:false};
    let result;
    if(adv){
      if(typeof adv!=='string'||adv.length>50000)return {ok:false};
      const query=JSON.parse(adv) as AdvancedSearchQuery;
      if(!query||!Array.isArray(query.conditions)||query.conditions.length>100||!['AND','OR'].includes(query.combinator))return {ok:false};
      const [categories,locations,statuses,custom]=await Promise.all([listCategories(),listLocations(),listStatuses(),listCustomFieldDefinitions()]);
      const fields=new Map(buildSearchFieldDefs(custom,{categories,locations,statuses}).map(field=>[field.key,field]));
      result=await listInventoryAdvanced({...query,conditions:completeConditions(query)},fields,{offset:0,limit:1},filters);
    }else result=await listInventorySimpleSearch(filters,{offset:0,limit:1});
    return Number.isFinite(result.totalQuantity)?{ok:true,totalQuantity:result.totalQuantity!}:{ok:false};
  }catch{return {ok:false};}
}

/**
 * 在庫の総件数だけを返す。
 *
 * 一覧の描画とは別経路にしてある（理由は InventoryTotalCount.tsx の
 * コメント参照）。ここで失敗しても一覧は表示され続ける。
 *
 * 例外を投げずに `{ok:false}` を返すのは、このリポジトリの他の
 * Server Action と同じ理由 —— production build では throw した
 * メッセージが Next.js にマスクされ、利用者に何も伝わらない
 * （app/actions/ai.ts 冒頭のコメント）。
 */
export async function getInventoryCountAction(
  filters: InventoryCursorListFilters,
): Promise<{ ok: true; total: number } | { ok: false }> {
  try {
    const role = await getInventoryRole();
    // 一覧を見られる人だけ。認証境界は速度のために緩めない（§8.2）。
    if (!role) return { ok: false };
    return { ok: true, total: await countActiveInventory(filters) };
  } catch (err) {
    console.warn("[inventoryCount] 件数を集計できませんでした", { error: err instanceof Error ? err.name : "unknown" });
    return { ok: false };
  }
}
