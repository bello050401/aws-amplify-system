"use server";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { readYahooRuntimeSession } from "@/lib/listing/yahooAuction/webHttpRuntime";

/** Authenticated server read only. Does not upload, draft, preview or publish. */
export async function checkYahooHttpsConnectionAction(): Promise<
  {ok:true;checkedAt:string} | {ok:false;code:string}> {
  if (!canEditInventory(await getInventoryRole())) return {ok:false,code:"FORBIDDEN"};
  const runtime = await readYahooRuntimeSession();
  if (!runtime.ok) return runtime;
  const result = await runtime.session.inspectInput();
  return result.ok ? {ok:true,checkedAt:new Date().toISOString()} : {ok:false,code:result.code};
}
