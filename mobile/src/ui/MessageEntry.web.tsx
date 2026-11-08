import React from 'react';
export function MessageEntry({onClose}:{onClose:()=>void}){
  return <div style={{height:'100%',minHeight:0,display:'flex',flexDirection:'column',background:'#F8F6F1'}}>
    <header style={{display:'flex',alignItems:'center',gap:12,padding:'10px 16px',borderBottom:'1px solid #E3E7E1'}}>
      <button onClick={onClose} style={{minHeight:44,padding:'0 12px',border:'1px solid #D9E2DA',borderRadius:12,background:'white',color:'#263D3C',fontSize:16}}>‹ ホーム</button>
      <strong style={{fontSize:18,color:'#263D3C'}}>メッセージ</strong>
    </header>
    <iframe title="メッセージと返信案" src="/staff-messages" allow="clipboard-write" style={{flex:1,minHeight:0,width:'100%',border:0}}/>
  </div>;
}
