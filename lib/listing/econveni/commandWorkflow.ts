import "server-only";
import {randomUUID} from "node:crypto";
import {EconveniHttpError,type EconveniHttpSession,type EconveniMarket} from "./httpSession";
import {EconveniWorkflowError,type EconveniWorkflowStore,reserveEconveniOperation,type EconveniWorkflow} from "./workflowStore";
import {reconcileEconveniChannel} from "./reconciliation";

type Store=Pick<EconveniWorkflowStore,"read"|"commit"|"stop">;
type Session=Pick<EconveniHttpSession,"readInventory"|"publicationPreview"|"executeCommand">;

/** The shared account lease must be held for this bounded step. The durable reservation
 * is committed BEFORE the external command, including when the command uses GET.
 * PENDING/VERIFY_REQUIRED always takes the read-only reconciliation path.
 */
export async function runEconveniCommand(store:Store,session:Session,input:{inventoryId:string;channel:EconveniMarket;operation:"PUBLISH"|"STOP";fingerprint:string;title:string;price:number;allowMercariRemoval?:boolean}):Promise<EconveniWorkflow> {
  let current=await store.read();
  if(!current||current.inventoryId!==input.inventoryId||!current.save.productId) throw new EconveniWorkflowError("INVALID_TRANSITION");
  const own=current.channels[input.channel];
  if(["PENDING","VERIFY_REQUIRED"].includes(own.state)){
    const remote=await session.readInventory(input.inventoryId);
    const reconciled=reconcileEconveniChannel(current,remote,input.channel);
    return store.commit(current,reconciled);
  }
  const reserved=reserveEconveniOperation(current,input.channel,input.fingerprint,randomUUID(),input.operation);
  if(!reserved) return current;
  // The observed Shops "stop" action deletes the product; it is not an UNOPENED toggle.
  // Never silently replace BELLO's existing non-public stop with this operation.
  // This flag must come from an explicitly authorized server policy, not a client form.
  if(input.channel==="MERCARI_SHOPS"&&input.operation==="STOP"&&input.allowMercariRemoval!==true)
    throw new EconveniWorkflowError("REMOVAL_NOT_AUTHORIZED");
  // Guard against stale external status before sending, not only against stale BELLO state.
  const remote=await session.readInventory(input.inventoryId);
  if(!remote||remote.productId!==current.save.productId||remote.channels[input.channel].state==="EXCLUDED") throw new EconveniWorkflowError("VERIFY_REQUIRED");
  const observed=remote.channels[input.channel];
  if(input.operation==="PUBLISH"&&observed.state!=="INACTIVE"||input.operation==="STOP"&&(observed.state!=="ACTIVE"||observed.listingId!==own.listingId)) throw new EconveniWorkflowError("VERIFY_REQUIRED");
  const command=await session.publicationPreview({channel:input.channel,operation:input.operation,productId:current.save.productId,title:input.title,price:input.price});
  current=await store.commit(current,reserved,true);
  try {
    await session.executeCommand(command);
    const result=await session.readInventory(input.inventoryId);
    const reconciled=reconcileEconveniChannel(current,result,input.channel);
    return await store.commit(current,reconciled);
  }catch(error){
    const code=error instanceof EconveniHttpError?error.code:"REMOTE_RESULT_UNCONFIRMED";
    // Do not let a failed attempt to persist an error mask the durable PENDING record.
    const uncertain={...current,channels:{...current.channels,[input.channel]:{...current.channels[input.channel],state:"VERIFY_REQUIRED" as const,errorCode:code}}};
    try{current=await store.commit(current,uncertain);}catch{/* PENDING still blocks duplicate sends. */}
    if(code==="AUTH_REQUIRED"||code==="ACCESS_DENIED"||code==="ADDITIONAL_AUTH"){
      await store.stop(code);
    }
    return current;
  }
}
