// Cross-invocation serialization without consuming reserved Lambda concurrency.
// The lease outlives the 90-second Lambda timeout, including an interrupted request.
export async function withIssuerLease<T>(acquire:()=>Promise<boolean>,release:()=>Promise<void>,work:()=>Promise<T>):Promise<T|{ok:false;code:'BUSY';message:string}>{
 if(!await acquire())return {ok:false,code:'BUSY',message:'別の帳票処理を実行中です。少し待ってからもう一度操作してください。'};
 try{return await work();}finally{try{await release();}catch{/* The bounded lease expires automatically. */}}
}
