import {readFileSync,writeFileSync} from 'node:fs';
import {readManualSync,refreshManualSync,linkExternalProduct,productFingerprint} from '../../lib/listing/econveni/manualSync';
async function main(){
 const dir='artifacts/econveni-parity-20261112',a=JSON.parse(readFileSync(dir+'/link-audit.json','utf8'));
 // These pairs were reviewed individually using the remote / stock photo contact sheets.
 const selected:Record<number,number>={0:0,1:1,2:0,3:1,4:0,5:0,6:0,7:0,8:0,9:0,10:1,11:1,12:0,13:0,14:0,15:0,16:0,17:0,18:2,19:0,20:0,21:0,22:0,24:0,25:3,28:3,29:0};
 const plan=Object.entries(selected).map(([i,n])=>({productId:a.unlinked[Number(i)].product.productId,inventoryId:a.unlinked[Number(i)].candidates[n].item.id}));
 plan.push({productId:a.unlinked[27].product.productId,inventoryId: '7c0a2963-9f90-435e-8752-ba646e206c30'});
 writeFileSync(dir+'/link-approved.json',JSON.stringify(plan,null,2));
 if(!process.argv.includes('--apply')){console.log({reviewed:plan.length});return;}
 let data=await readManualSync();if(!data.snapshot||Date.now()-Date.parse(data.snapshot.checkedAt)>25*60000)data=await refreshManualSync();
 const results=[];
 for(const p of plan){if(data.links.some(l=>l.productId===p.productId&&l.inventoryId===p.inventoryId)){results.push({...p,status:'already-linked'});continue;}
  const remote=data.snapshot!.products.find(r=>r.productId===p.productId);if(!remote)throw Error('REMOTE_MISSING');
  data=await linkExternalProduct({...p,confirmed:true,version:data.snapshot!.version,fingerprint:productFingerprint(remote)},'BELLO_VISUAL_REVIEW_20261112',true);
  results.push({...p,status:'linked'});writeFileSync(dir+'/link-applied.json',JSON.stringify(results,null,2));console.log(p.productId,'linked');
 }
 writeFileSync(dir+'/link-applied.json',JSON.stringify(results,null,2));console.log({verified:results.length});
}main().catch(e=>{console.error(e.name,e.message);process.exitCode=1});
