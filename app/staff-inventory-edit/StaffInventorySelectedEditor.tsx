'use client';
import {useEffect,useState} from 'react';
import {DirectEditProvider} from '@/app/inventory/(protected)/DirectEditProvider';
import {InventorySelectionProvider} from '@/app/inventory/(protected)/InventorySelectionProvider';
import {InventoryBulkControls} from '@/app/inventory/(protected)/InventoryBulkPanel';
import {parseSelectionRequest,type SelectionRequest} from '@/lib/inventory/selectionRequest';
import type {CustomFieldDefinitionRow,MasterOption} from '@/lib/inventory/queries';

/** No second inventory search: receive the exact selection from the staff list. */
export function StaffInventorySelectedEditor({categories,locations,customFieldDefs}:{categories:MasterOption[];locations:MasterOption[];customFieldDefs:CustomFieldDefinitionRow[]}){
  const [request,setRequest]=useState<SelectionRequest|null>(null);
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(event.origin!==window.location.origin||event.source!==window.parent||event.data?.type!=='bello:inventory-selection')return;
      const parsed=parseSelectionRequest(event.data.request);
      if(parsed)setRequest(current=>current??parsed);
    };
    window.addEventListener('message',receive);
    window.parent.postMessage({type:'bello:inventory-editor-ready'},window.location.origin);
    return()=>window.removeEventListener('message',receive);
  },[]);
  const notify=(type:string,ids?:string[])=>window.parent.postMessage({type,ids},window.location.origin);
  if(!request)return <p role="status" className="p-5 text-sm text-gray-600">選択した商品を準備しています…</p>;
  return <InventorySelectionProvider editable initialIds={request.ids} key={request.requestId}><DirectEditProvider rows={[]}>
    <InventoryBulkControls categories={categories} locations={locations} customFieldDefs={customFieldDefs} embedded initialRequest={request}
      onDismiss={()=>notify('bello:inventory-editor-dismissed')}
      onWorking={working=>notify(working?'bello:inventory-editor-working':'bello:inventory-editor-finished')}
      onSaved={ids=>notify('bello:inventory-editor-saved',ids)}/>
  </DirectEditProvider></InventorySelectionProvider>;
}
