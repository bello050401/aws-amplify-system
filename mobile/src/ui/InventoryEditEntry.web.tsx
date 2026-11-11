import React, {useEffect, useRef, useState} from 'react';
import type {SelectionRequest} from '../../../lib/inventory/selectionRequest';
export function InventoryEditEntry({selection,hidden,onClose,onFinished}:{selection:SelectionRequest;hidden?:boolean;onClose:(changed:boolean,pending:boolean)=>void;onFinished:(changed:boolean)=>void}) {
  const frame=useRef<HTMLIFrameElement>(null), request=useRef<string|null>(null);
  const acknowledged=useRef(false), changed=useRef(false), working=useRef(false);
  const latest=useRef({selection,hidden,onClose,onFinished});
  latest.current={selection,hidden,onClose,onFinished};
  const [ready,setReady]=useState(false);
  const [closing,setClosing]=useState(false);
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(event.origin!==window.location.origin||event.source!==frame.current?.contentWindow)return;
      if(event.data?.type==='bello:inventory-editor-ready'){
        setReady(true);frame.current?.contentWindow?.postMessage({type:'bello:inventory-selection',request:latest.current.selection},window.location.origin);return;
      }
      if(event.data?.type==='bello:inventory-editor-working'){working.current=true;return;}
      if(event.data?.type==='bello:inventory-editor-finished'){working.current=false;if(latest.current.hidden){latest.current.onFinished(changed.current);changed.current=false;}return;}
      if(event.data?.type==='bello:inventory-editor-saved'){changed.current=true;return;}
      if(event.data?.type==='bello:inventory-editor-dismissed'){latest.current.onClose(changed.current,working.current);return;}
      if(event.data?.requestId!==request.current)return;
      if(event.data?.type==='bello:inventory-close-pending'){acknowledged.current=true;return;}
      if(event.data?.type!=='bello:inventory-close-response')return;
      request.current=null;setClosing(false);if(event.data.allowed===true)latest.current.onClose(changed.current,working.current);
    };
    window.addEventListener('message',receive);
    return()=>{request.current=null;window.removeEventListener('message',receive);};
  },[]);
  const close=()=>{
    if(closing)return;
    if(!ready){onClose(changed.current,working.current);return;}
    request.current=crypto.randomUUID();acknowledged.current=false;setClosing(true);
    frame.current?.contentWindow?.postMessage({type:'bello:inventory-close-request',requestId:request.current},window.location.origin);
    setTimeout(()=>{if(request.current&&!acknowledged.current){request.current=null;setClosing(false);
      if(window.confirm('編集画面の応答がありません。未保存の入力が失われる可能性があります。在庫一覧へ戻りますか？'))onClose(changed.current,working.current);
    }},5000);
  };
  return <div style={{height:'100%',minHeight:0,display:'flex',flexDirection:'column',background:'#F8F6F1'}}>
    <header style={{display:'flex',alignItems:'center',gap:12,padding:'10px 16px',borderBottom:'1px solid #E3E7E1'}}>
      <button disabled={closing} onClick={close} style={{minHeight:44,padding:'0 12px',border:'1px solid #D9E2DA',borderRadius:12,background:'white',color:'#263D3C',fontSize:16}}>‹ 在庫一覧</button>
      <strong style={{fontSize:18,color:'#263D3C'}}>{selection.mode==='edit'?'商品を編集':selection.mode==='undo'?'変更を戻す':selection.mode==='redo'?'変更を進める':'変更履歴'} <span style={{fontSize:13,fontWeight:400}}>{selection.ids.length}件</span></strong>
    </header>
    {!ready&&<p role="status" style={{margin:0,padding:'12px 16px',fontSize:14,color:'#53645F'}}>編集画面を準備しています…</p>}
    <iframe ref={frame} title="選択商品の編集" src="/staff-inventory-edit?selected=1" style={{flex:1,minHeight:0,width:'100%',border:0}}/>
  </div>;
}
