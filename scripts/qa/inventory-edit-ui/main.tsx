import React,{useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {products,categories,notify,subscribe,snapshot} from './store';
import {InventoryTable} from '../../../app/inventory/(protected)/InventoryTable';
import {InventoryBulkControls} from '../../../app/inventory/(protected)/InventoryBulkPanel';
import {DirectEditProvider,useDirectEdit} from '../../../app/inventory/(protected)/DirectEditProvider';
import {DirectEditControls} from '../../../app/inventory/(protected)/DirectEditControls';
import {InventorySelectionProvider} from '../../../app/inventory/(protected)/InventorySelectionProvider';
import {UnsavedChangesProvider} from '../../../app/inventory/UnsavedChangesProvider';
import {StaffInventoryEditList} from '../../../app/staff-inventory-edit/StaffInventoryEditList';
function DirectButtons(){return <div className="border-b bg-white p-3"><DirectEditControls/></div>;}
function App(){useSyncExternalStore(subscribe,snapshot);const page=Number(new URLSearchParams(location.search).get('page')??0),rows=[...products.values()].slice(page*50,(page+1)*50),phone=new URLSearchParams(location.search).has('phone');return <UnsavedChangesProvider><InventorySelectionProvider editable><div className="flex h-screen flex-col bg-white pb-[calc(3.5rem+var(--inventory-selection-space))] md:pb-[var(--inventory-selection-space)]"><div className="bg-amber-50 px-4 py-2 text-sm">操作確認用・匿名の商品60件（実在庫やECは変更しません）</div>{phone?<StaffInventoryEditList rows={rows} categories={categories} q="" offset={page*50} total={60}/>:<DirectEditProvider rows={rows}><DirectButtons/><InventoryBulkControls categories={categories}/><div className="min-h-0 flex-1 overflow-auto pb-20"><InventoryTable rows={rows} categories={categories} locations={[]} categoriesById={Object.fromEntries(categories.map(c=>[c.id,c]))} locationsById={{}} statusesById={{}} customFieldDefs={[]} listReturnQuery=""/></div><div className="flex gap-3 p-3"><button onClick={()=>{history.pushState({},'','?page=0');notify();}}>1ページ目</button><button onClick={()=>{history.pushState({},'','?page=1');notify();}}>2ページ目</button></div></DirectEditProvider>}</div></InventorySelectionProvider></UnsavedChangesProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
