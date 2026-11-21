import React from 'react';
import { PROCUREMENT_PROVIDERS, staffProcurementPath } from '../../../lib/procurement/providers';
export const procurementAvailable = true;
export function ProcurementEntry({onClose,offline,preview}:{onClose:()=>void;offline:boolean;preview?:boolean}) {
  return <main aria-label="仕入れ取込" style={{flex:1,overflowY:'auto',background:'#F8F6F1',padding:16}}>
    <div style={{maxWidth:620,margin:'0 auto',width:'100%'}}>
      <button type="button" onClick={onClose} style={{minHeight:44,border:0,background:'transparent',color:'#36746A',fontSize:15}}>← ホームに戻る</button>
      <h1 style={{fontSize:24,color:'#263D3C',margin:'16px 0 8px'}}>仕入れ取込</h1>
      <p style={{fontSize:14,lineHeight:1.7,color:'#526B63'}}>仕入れ先を選んで、取得・確認・登録を行います。</p>
      {offline && <p role="status">圏外です。通信を回復してから開いてください。</p>}
      {preview && <p role="status">操作確認用です。仕入れ先の取得・登録は実行しません。</p>}
      <nav aria-label="仕入れ先" style={{display:'grid',gap:12,marginTop:24}}>
        {PROCUREMENT_PROVIDERS.map(provider => offline || preview
          ? <button key={provider.key} type="button" disabled style={sourceStyle}>{provider.mobileLabel}</button>
          : <a key={provider.key} href={staffProcurementPath(provider.key)} style={sourceStyle}>{provider.mobileLabel}<span aria-hidden="true"> →</span></a>)}
      </nav>
    </div>
  </main>;
}
const sourceStyle: React.CSSProperties = {display:'block',boxSizing:'border-box',width:'100%',minHeight:64,padding:18,border:'1px solid #D5DFD7',borderRadius:16,background:'white',color:'#263D3C',fontSize:16,fontWeight:600,lineHeight:1.5,textDecoration:'none',textAlign:'left',overflowWrap:'anywhere'};
