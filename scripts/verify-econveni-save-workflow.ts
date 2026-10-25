import assert from "node:assert/strict";
import { runEconveniSave } from "../lib/listing/econveni/saveWorkflow";
import { initialEconveniWorkflow,type EconveniWorkflow } from "../lib/listing/econveni/workflowStore";
import { EconveniHttpError, type EconveniRemoteProduct } from "../lib/listing/econveni/httpSession";
const id="inventory-save-test";
const input={inventoryId:id,fingerprint:"same-source",fields:{products_name:"chair",products_price:"1000"},
  images:[{bytes:Buffer.from([1,2,3]),filename:"1.jpg",mimeType:"image/jpeg" as const}]};
async function scenario(failAt:"none"|"reservation"|"response"|"verification"|"ack"){
 let state:EconveniWorkflow|null=null,remote:EconveniRemoteProduct|null=null,sends=0,stopped=0,commits=0;
 const store={read:async()=>state,stop:async()=>{stopped++;},commit:async(before:EconveniWorkflow|null,next:EconveniWorkflow)=>{
  commits++;if(failAt==="reservation"&&commits===1)throw Error("database unavailable");
  if(failAt==="ack"&&sends)throw Error("lost acknowledgement");
  state={...next,revision:(before?.revision??0)+1};return state;
 }};
 const session={readInventory:async()=>remote,saveProduct:async(inventoryId:string,operationId:string)=>{
  assert.equal(state?.save.state,"PENDING");assert.equal(state?.save.expected?.imageHashes.length,1);
  sends++;remote={productId:"123",url:"https://smart.e-conveni.net/product.php?action=product_update&products_id=123",
    operationId,channels:{YAHOO:{state:"INACTIVE",listingId:null,listingUrl:null},MERCARI_SHOPS:{state:"INACTIVE",listingId:null,listingUrl:null}}};
  if(failAt==="response")throw new EconveniHttpError("NETWORK");
  return {html:"",url:"",status:200};
 },verifySavedProduct:async()=>failAt!=="verification"};
 if(failAt==="reservation"){
  await assert.rejects(runEconveniSave(store,session,input));assert.equal(sends,0);return;
 }
 const first=await runEconveniSave(store,session,input);assert.equal(sends,1);
 if(failAt==="ack"){assert.equal(first.save.state,"PENDING");return;}
 assert.equal(first.save.state,failAt==="none"?"SUCCEEDED":"VERIFY_REQUIRED");
 // A changed form must not erase the snapshot of an uncertain operation.
 const next=await runEconveniSave(store,session,failAt==="none"?input:{...input,fingerprint:"changed",fields:{products_name:"different"}});
 assert.equal(sends,1);
 assert.equal(next.save.state,failAt==="verification"?"VERIFY_REQUIRED":"SUCCEEDED");
 if(failAt==="response"){assert.equal(next.save.fingerprint,"same-source");assert.equal(next.save.expected?.fields.products_name,"chair");}
 assert.equal(stopped,0);
}
async function main(){
 for(const at of ["none","reservation","response","verification","ack"] as const)await scenario(at);
 const existing={...initialEconveniWorkflow(id),save:{state:"SUCCEEDED" as const,productId:"123",fingerprint:"old"}};
 let sends=0;const store={read:async()=>existing,stop:async()=>{},commit:async()=>{throw Error("unexpected");}};
 const session={readInventory:async()=>null,saveProduct:async()=>{sends++;throw Error("unexpected");},verifySavedProduct:async()=>true};
 await assert.rejects(runEconveniSave(store,session,input),/VERIFY_REQUIRED/);assert.equal(sends,0);
 console.log("PASS: durable save before HTTP; exact evidence; response loss reconciliation; changed inputs cannot resend; missing existing binding never creates replacement; failed durable reservation sends nothing");
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
