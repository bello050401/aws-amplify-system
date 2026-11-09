'use client';
export type PostSaleJobView={state:string;reason?:string;updatedAt:string};
export function PostSaleJobStatus({job}:{job?:PostSaleJobView}){
 if(!job)return null;
 const done=job.state==='SALE_EC_COMPLETE',attention=job.state==='SALE_EC_ATTENTION';
 return <div role={attention?'alert':'status'} style={{borderRadius:10,padding:'12px 14px',marginTop:12,background:done?'#edf5ef':attention?'#fff5e4':'#f1f4f3',fontSize:13,lineHeight:1.7}}><strong>{done?'出品停止・数量変更を確認済み':attention?'販売先の確認が必要です':'出品停止・数量変更を処理中'}</strong><div>{attention?job.reason:done?'各販売先の反映結果を確認しました。':'画面を閉じても処理は続きます。'}</div></div>;
}
