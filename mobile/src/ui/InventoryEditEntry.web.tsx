import React, {useEffect, useRef, useState} from 'react';
export function InventoryEditEntry({onClose}:{onClose:()=>void}) {
  const frame=useRef<HTMLIFrameElement>(null), request=useRef<string|null>(null);
  const acknowledged=useRef(false);
  const [closing,setClosing]=useState(false);
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(event.origin!==window.location.origin||event.source!==frame.current?.contentWindow||event.data.requestId!==request.current)return;
      if(event.data?.type==='bello:inventory-close-pending'){acknowledged.current=true;return;}
      if(event.data?.type!=='bello:inventory-close-response')return;
      request.current=null;setClosing(false);if(event.data.allowed===true)onClose();
    };
    window.addEventListener('message',receive);
    return()=>{request.current=null;window.removeEventListener('message',receive);};
  },[onClose]);
  const close=()=>{
    if(closing)return;
    request.current=crypto.randomUUID();acknowledged.current=false;setClosing(true);
    frame.current?.contentWindow?.postMessage({type:'bello:inventory-close-request',requestId:request.current},window.location.origin);
    setTimeout(()=>{if(request.current&&!acknowledged.current){request.current=null;setClosing(false);
      if(window.confirm('編集画面の応答がありません。未保存の入力が失われる可能性があります。在庫一覧へ戻りますか？'))onClose();
    }},5000);
  };
  return <div style={{height:'100%',minHeight:0,display:'flex',flexDirection:'column',background:'#F8F6F1'}}>
    <header style={{display:'flex',alignItems:'center',gap:12,padding:'10px 16px',borderBottom:'1px solid #E3E7E1'}}>
      <button disabled={closing} onClick={close} style={{minHeight:44,padding:'0 12px',border:'1px solid #D9E2DA',borderRadius:12,background:'white',color:'#263D3C',fontSize:16}}>‹ 在庫一覧</button>
      <strong style={{fontSize:18,color:'#263D3C'}}>一括編集・変更履歴</strong>
    </header>
    <iframe ref={frame} title="在庫の一括編集・戻る・進む" src="/staff-inventory-edit" style={{flex:1,minHeight:0,width:'100%',border:0}}/>
  </div>;
}
