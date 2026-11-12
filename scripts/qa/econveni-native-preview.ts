import {writeFileSync} from 'node:fs';
import {EconveniHttpSession} from '../../lib/listing/econveni/httpSession';
import {econveniCredentialStore} from '../../lib/listing/econveni/credentials';
import {econveniStore} from '../../lib/listing/econveni/runtimeStore';
import {withEconveniAccount} from '../../lib/listing/econveni/accountWorkflow';
import {readManualSync} from '../../lib/listing/econveni/manualSync';
async function main(){
 const session=new EconveniHttpSession(),results:any[]=[];
 await withEconveniAccount(econveniStore('native-contract-reader'),session,()=>econveniCredentialStore.credentials(),async()=>{
  const {snapshot}=await readManualSync();if(!snapshot)throw Error('SNAPSHOT_MISSING');
  for(const channel of ['YAHOO','MERCARI_SHOPS','BASE'] as const)for(const operation of ['PUBLISH','CLEAR','STOP'] as const){
   const p=snapshot.products.find(p=>p.quantity>0&&(operation==='PUBLISH'?p.channels[channel].state==='INACTIVE'&&!p.channels[channel].listingId:p.channels[channel].state==='ACTIVE'&&p.channels[channel].listingId));
   if(!p)throw Error('NO_PREVIEW_TARGET');
   const start=Date.now();try{const command=await session.nativePreview(p.productId,channel,operation);results.push({channel,operation,productId:p.productId,result:'PREVIEW_VERIFIED',path:new URL(command.url).pathname,durationMs:Date.now()-start});}catch(e){results.push({channel,operation,productId:p.productId,result:'FAILED',code:(e as any).code??(e as Error).name});}
  }
 });
 writeFileSync('artifacts/econveni-parity-20261112/native-live-previews.json',JSON.stringify({at:new Date().toISOString(),externalCommandsSent:0,results},null,2));
 console.log(JSON.stringify(results));if(results.some(r=>r.result!=='PREVIEW_VERIFIED'))process.exitCode=1;
}main().catch(e=>{console.error((e as any).code??(e as Error).name);process.exitCode=1;});
