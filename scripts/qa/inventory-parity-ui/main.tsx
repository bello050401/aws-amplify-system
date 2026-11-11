import {StaffInventorySelectedEditor} from '../../../app/staff-inventory-edit/StaffInventorySelectedEditor';
import React,{useState,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {products,categories,subscribe,snapshot,customDefinitions} from "../inventory-edit-ui/store";
import {InventoryTable} from "../../../app/inventory/(protected)/InventoryTable";
import {InventoryBulkControls} from "../../../app/inventory/(protected)/InventoryBulkPanel";
import {DirectEditProvider} from "../../../app/inventory/(protected)/DirectEditProvider";
import {InventorySelectionProvider} from "../../../app/inventory/(protected)/InventorySelectionProvider";
import {UnsavedChangesProvider} from "../../../app/inventory/UnsavedChangesProvider";
import {InventorySidebar} from "../../../app/inventory/(protected)/InventorySidebar";
import {InventoryAdvancedSearchPanel} from "../../../app/inventory/(protected)/InventoryAdvancedSearchPanel";
import {InventoryListTools} from "../../../app/inventory/(protected)/InventoryListTools";
import {InventoryPagination} from "../../../app/inventory/(protected)/InventoryPagination";
import {InventoryToolbar} from "../../../app/inventory/(protected)/InventoryToolbar";
import {buildSearchFieldDefs,evaluateQuery,createQuickSearchMatcher} from "../../../lib/inventory/advancedSearch";
import {inventoryComparator,parseInventoryListSort} from "../../../lib/inventory/searchSort";
import {NavigationFaultControl} from "./navigation";
import {LabeledInput} from "../../../app/inventory/(protected)/FormFields";
import {InventoryQuantityTotal} from "../../../app/inventory/(protected)/InventoryQuantityTotal";
const locations=[{id:"L1",name:"所沢事務所",parentId:null,sortOrder:1},{id:"L2",name:"検証倉庫",parentId:null,sortOrder:2}];
const fields=buildSearchFieldDefs(customDefinitions,{categories,locations,statuses:[]}),fieldMap=new Map(fields.map(f=>[f.key,f]));
function App(){
  useSyncExternalStore(subscribe,snapshot);
  const params=new URLSearchParams(location.search),ids=(params.get("categoryIds")??"").split(",").filter(Boolean);
  const advanced=params.get("adv")?JSON.parse(params.get("adv")!):null;
  const all=[...products.values()].filter(r=>(!ids.length||ids.some(id=>r.categoryIds.includes(id)))&&
    (!params.get("locationId")||r.locationId===params.get("locationId"))&&
    (!advanced||evaluateQuery(r,advanced,fieldMap))&&createQuickSearchMatcher(params.get("q")??"")(r));
  all.sort(inventoryComparator(parseInventoryListSort(params.get("sort")??undefined,params.get("direction")??undefined),fieldMap));
  const offset=Number(params.get("offset")??0),limit=params.get("limit")==="100"?100:50,rows=all.slice(offset,offset+limit);
  return <UnsavedChangesProvider><InventorySelectionProvider editable><DirectEditProvider rows={rows}>
    <div className="flex h-screen flex-col pb-[var(--inventory-selection-space)]">
      <div className="bg-amber-50 px-4 py-2 text-sm">操作確認用・匿名の商品（実在庫・ECは変更しません）<NavigationFaultControl/></div>
      <header className="border-b bg-white p-4"><InventoryToolbar role="EDITOR" q={params.get("q")??undefined} categoryIds={ids} locationId={params.get("locationId")??undefined} advancedOpen={params.has("advanced")} advancedActive={Boolean(advanced)} advRaw={params.get("adv")??undefined} totalLabel={<>{all.length}件<InventoryQuantityTotal key={params.toString()} filters={{q:params.get('q')??undefined}} known={params.has('quantity-failure')?undefined:all.reduce((sum,row)=>sum+row.quantity,0)}/></>} resultQuery={params.toString()}/></header>
      <InventoryBulkControls categories={categories} locations={locations} customFieldDefs={customDefinitions}/>
      <InventoryListTools customFieldDefs={customDefinitions} categories={categories} locations={locations}/>
      <div className="flex min-h-0 flex-1">
        <InventorySidebar categories={categories} locations={locations} activeCategoryIds={ids} activeLocationId={params.get("locationId")??undefined}/>
        {params.has("advanced")&&<InventoryAdvancedSearchPanel key={params.get("adv")??"empty"} fieldDefs={fields} initialQuery={advanced}/>}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto"><InventoryTable rows={rows} categories={categories} locations={locations} categoriesById={Object.fromEntries(categories.map(c=>[c.id,c]))} locationsById={Object.fromEntries(locations.map(l=>[l.id,l]))} statusesById={{}} customFieldDefs={customDefinitions} listReturnQuery={params.toString()}/></div>
          <InventoryPagination baseParams={Object.fromEntries(params)} limit={limit} offset={offset} total={all.length} currentCount={rows.length} hasNext={offset+limit<all.length}/>
        </div>
      </div>
    </div>
  </DirectEditProvider></InventorySelectionProvider></UnsavedChangesProvider>;
}
function NameFieldPreview(){
  const [name,setName]=useState('【確認用】Cassina ixc. TULU ダイニングチェア / ミッドセンチュリー モダン 名作 デザイナーズ チェア カッシーナ ツル / 高濱和秀（Knoll,B&B Italia）');
  return <main className="max-w-md space-y-6 p-6"><p>商品名入力の確認専用・保存なし</p><LabeledInput label="新規登録の物品名" required multiline value={name} onChange={setName}/><LabeledInput label="詳細編集の物品名" required multiline value={name} onChange={setName} size="large"/></main>;
}
// These additional IDs match the anonymous mobile photo fixture only.
for(let i=1;i<=24;i++){const id='11111111-1111-4111-8111-'+String(i).padStart(12,'0');if(!products.has(id))products.set(id,{...products.get('qa-0'),id,name:'写真確認 '+i+' チェア',sku:'写真確認'+i});}
createRoot(document.getElementById("root")!).render(location.pathname==='/staff-inventory-edit'?<UnsavedChangesProvider><StaffInventorySelectedEditor categories={categories} locations={locations} customFieldDefs={customDefinitions}/></UnsavedChangesProvider>:new URLSearchParams(location.search).has('name-field-test')?<NameFieldPreview/>:<App/>);
