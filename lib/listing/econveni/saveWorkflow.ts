import "server-only";
import { createHash,randomUUID } from "node:crypto";
import { EconveniHttpError,type EconveniHttpSession,type UploadImage } from "./httpSession";
import { EconveniWorkflowError,initialEconveniWorkflow,reserveEconveniOperation,type EconveniWorkflowStore,type EconveniWorkflow } from "./workflowStore";

type Store=Pick<EconveniWorkflowStore,"read"|"commit"|"stop">;
type Session=Pick<EconveniHttpSession,"readInventory"|"saveProduct"|"verifySavedProduct">;
export type EconveniSaveInput={inventoryId:string;fingerprint:string;fields:Record<string,string>;images:UploadImage[]};
export function saveEvidence(input:EconveniSaveInput) {
  return {fields:{...input.fields},imageHashes:input.images.map(i=>createHash("sha256").update(i.bytes).digest("hex"))};
}
/** Caller holds the account lease. All acknowledgements are verified by a fresh read,
 * including exact image count/order/bytes. After any uncertain write, this function
 * only reconciles the persisted expectation; changed user input cannot trigger resend.
 */
export async function runEconveniSave(store:Store,session:Session,input:EconveniSaveInput, prepareFields?:()=>Promise<Record<string,string>>):Promise<EconveniWorkflow> {
  let current=await store.read();
  const reconcile=async(state:EconveniWorkflow)=>{
    const remote=await session.readInventory(input.inventoryId);
    const verified=!!remote&&remote.operationId===state.save.operationId&&
      (!state.save.productId||remote.productId===state.save.productId)&&!!state.save.expected&&
      await session.verifySavedProduct(remote,state.save.expected);
    return store.commit(state,{...state,save:{...state.save,
      state:verified?"SUCCEEDED":"VERIFY_REQUIRED",
      productId:verified?remote!.productId:state.save.productId,
      errorCode:verified?undefined:"SAVE_RESULT_UNCONFIRMED"}});
  };
  if(current&&["PENDING","VERIFY_REQUIRED"].includes(current.save.state))return reconcile(current);
  const initial=current??initialEconveniWorkflow(input.inventoryId);
  if(initial.inventoryId!==input.inventoryId)throw new EconveniWorkflowError("INVALID_TRANSITION");
  const reserved=reserveEconveniOperation(initial,"SAVE",input.fingerprint,randomUUID());
  if(!reserved)return initial;
  const remote=await session.readInventory(input.inventoryId);
  if(initial.save.productId ? remote?.productId!==initial.save.productId : remote!==null)
    throw new EconveniWorkflowError("VERIFY_REQUIRED");
  // PENDING and the complete expected result are durable before the first write.
  current=await store.commit(current,{...reserved,save:{...reserved.save,expected:saveEvidence(input)}},true);
  try{
    if(prepareFields){
      input={...input,fields:await prepareFields()};
      current=await store.commit(current,{...current,save:{...current.save,expected:saveEvidence(input)}});
    }
    await session.saveProduct(input.inventoryId,current.save.operationId!,input.fields,input.images,remote);
    return await reconcile(current);
  }catch(error){
    const code=error instanceof EconveniHttpError?error.code:"SAVE_RESULT_UNCONFIRMED";
    try{current=await store.commit(current,{...current,save:{...current.save,state:"VERIFY_REQUIRED",errorCode:code}});}
    catch{/* The durable PENDING record still blocks retransmission. */}
    if(["AUTH_REQUIRED","ACCESS_DENIED","ADDITIONAL_AUTH"].includes(code))
      await store.stop(code as "AUTH_REQUIRED"|"ACCESS_DENIED"|"ADDITIONAL_AUTH");
    return current;
  }
}
