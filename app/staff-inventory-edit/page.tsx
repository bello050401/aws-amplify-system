import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {listCategories,listInventorySimpleSearch,listLocations,listCustomFieldDefinitions} from '@/lib/inventory/queries';
import {selectableLocations} from '@/lib/inventory/locationChoices';
import {StaffInventorySelectedEditor} from './StaffInventorySelectedEditor';
import {withListImageUrls} from '@/lib/inventory/listImageUrls';
import {StaffInventoryEditList} from './StaffInventoryEditList';
export default async function Page({searchParams}:{searchParams:Promise<{q?:string;offset?:string;selected?:string}>}){
 if(!await inventoryMutationSession())return null;
 const params=await searchParams,q=params.q?.slice(0,200)??'',offset=Math.max(0,Math.min(100000,Number(params.offset)||0));
 if(params.selected==='1'){
  const [categories,locations,customFieldDefs]=await Promise.all([listCategories(),listLocations(),listCustomFieldDefinitions()]);
  return <StaffInventorySelectedEditor categories={categories} locations={selectableLocations(locations)} customFieldDefs={customFieldDefs}/>;
 }
 const [page,categories]=await Promise.all([listInventorySimpleSearch({q},{offset,limit:50}),listCategories()]);
 return <StaffInventoryEditList rows={await withListImageUrls(page.items)} categories={categories} q={q} offset={offset} total={page.total}/>;
}
