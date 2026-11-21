import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {HomeScreen} from '../../../mobile/src/ui/HomeScreen';
import {ProcurementEntry} from '../../../mobile/src/ui/ProcurementEntry.web';
import ProcurementPanel from '../../../app/inventory/(protected)/procurement/ProcurementPanel';
import {procurementProvider,STAFF_APP_HOME} from '../../../lib/procurement/providers';
function Fixture(){
 const [open,setOpen]=useState(false),[offline,setOffline]=useState(false);
 const params=new URLSearchParams(location.search),isPanel=location.pathname==='/inventory/procurement',viewer=params.has('viewer');
 const noop=()=>{};
 return <><aside style={{padding:8,fontSize:12,background:'#FFF4CE'}}>匿名・架空データの動作確認。外部接続・実在庫更新なし。<button onClick={()=>setOffline(v=>!v)}>{offline?'通信を戻す':'圏外を試す'}</button></aside>{isPanel?<main id="bello-outbound"><a href={STAFF_APP_HOME}>← ホームに戻る</a><h1>定期仕入れ</h1>{viewer?<p>この機能は在庫を編集できるスタッフが利用できます。</p>:<ProcurementPanel initialProvider={procurementProvider(params.get('provider'))}/>}</main>:open?<ProcurementEntry offline={offline} onClose={()=>setOpen(false)}/>:<HomeScreen offline={offline} writesEnabled={!viewer} creating={false} onCreate={noop} onInventory={noop} onScan={noop} onPriceEntry={noop} onProcurement={()=>setOpen(true)}/>}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
