import {UNKNOWN_RESULT} from './model';
import {ProviderFailure} from './provider';
export type OperationStore={transition:(from:string,to:string)=>Promise<void>};
// No automatic retry after a write may have reached MF. Even a lost response stays blocked.
export async function issueOnce<T>(store:OperationStore,create:()=>Promise<T>,recordFailure?:(code:string)=>Promise<void>):Promise<{ok:true;value:T}|{ok:false;code:'UNKNOWN';message:string}>{
 const unknown={ok:false as const,code:'UNKNOWN' as const,message:UNKNOWN_RESULT};
 try{await store.transition('READY','CREATING');}catch{return unknown;}
 try{const value=await create();await store.transition('CREATING','SAVED');return {ok:true,value};}
 catch(e){try{await store.transition('CREATING','UNKNOWN');}catch{}try{await recordFailure?.(e instanceof ProviderFailure?e.checkCode:'UNCONFIRMED');}catch{}return unknown;}
}
