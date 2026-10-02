import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => unknown) => unknown;
  }): void;
}

const projectRoot = pathToFileURL(process.cwd() + "/").href;
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: fake("export default {}"), shortCircuit: true };
    if (specifier === "next/headers") return { url: fake("export const headers=()=>({get:()=>globalThis.__orderOrigin})"), shortCircuit: true };
    if (specifier === "@/lib/amplify/requireInventoryUser") return {
      url: fake("export const getInventoryRole=async()=>globalThis.__orderRole"), shortCircuit: true,
    };
    if (specifier === "@/lib/listing/nextEngine/orderWindowClient") return {
      url: fake("export const readNextEngineOrderWindow=async(_tokens,_persist,window)=>{globalThis.__orderReads++;if(globalThis.__orderThrow)throw Error('private-value');return [{orderId:'3001',shopId:window.shopId,importedAt:window.from,statusId:'20'}]}"),
      shortCircuit: true,
    };
    if (specifier === "@/lib/listing/nextEngine/boundRead") return {
      url: fake("export const withBoundNextEngineRead=async run=>run({accessToken:'a',refreshToken:'r'},async()=>{},globalThis.__orderBinding)"),
      shortCircuit: true,
    };
    if (specifier === "@/lib/listing/nextEngine/privateMasterAcceptance") return {
      url: fake("export const PRIVATE_MASTER_STAGING_ORIGIN='https://qa.example.invalid'"), shortCircuit: true,
    };
    const target = specifier.startsWith("@/") ? projectRoot + specifier.slice(2) : specifier;
    try { return nextResolve(target, context); }
    catch { return nextResolve(target + ".ts", context); }
  },
});

const state = globalThis as typeof globalThis & {
  __orderOrigin: string; __orderRole: string; __orderReads: number; __orderThrow: boolean;
  __orderBinding: { clientId: string; clientSecret: string; expectedCompanyNeId: string; credentialVersionId: string };
};
const { previewNextEngineOrdersAction } = await import("@/app/actions/nextEngineOrderPreview");
const { nextEngineBindingReadRef } = await import("@/lib/listing/nextEngine/bindingReadRef");
const window = { shopId: "2", from: "2026-10-02 00:00:00", before: "2026-10-03 00:00:00" };
const secret = "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-tokens-staging-jAJyao";
state.__orderOrigin = "https://qa.example.invalid";
state.__orderRole = "ADMIN";
state.__orderReads = 0;
state.__orderThrow = false;
state.__orderBinding = { clientId: "fixture", clientSecret: "fixture-secret", expectedCompanyNeId: "A", credentialVersionId: "v1" };
const bindingRef = nextEngineBindingReadRef(state.__orderBinding);
process.env.NEXT_ENGINE_PUBLIC_ORIGIN = state.__orderOrigin;
process.env.NEXT_ENGINE_TOKEN_SECRET_ID = secret;

state.__orderOrigin = "https://other.example.invalid";
assert.equal((await previewNextEngineOrdersAction(window, bindingRef)).ok, false);
state.__orderOrigin = "https://qa.example.invalid";
process.env.NEXT_ENGINE_TOKEN_SECRET_ID = "wrong";
assert.equal((await previewNextEngineOrdersAction(window, bindingRef)).ok, false);
process.env.NEXT_ENGINE_TOKEN_SECRET_ID = secret;
state.__orderRole = "STAFF";
assert.equal((await previewNextEngineOrdersAction(window, bindingRef)).ok, false);
state.__orderRole = "ADMIN";
assert.equal((await previewNextEngineOrdersAction({ ...window, shopId: "" }, bindingRef)).ok, false);
assert.equal((await previewNextEngineOrdersAction({ ...window, before: "2026-10-04 00:00:01" }, bindingRef)).ok, false);
state.__orderBinding = { ...state.__orderBinding, expectedCompanyNeId: "B" };
const changed = await previewNextEngineOrdersAction(window, bindingRef);
assert.equal(changed.ok, false, "Company B must not use a shop selected under A");
assert.ok(!changed.ok && changed.message.includes("選び直し"));
state.__orderBinding = { ...state.__orderBinding, expectedCompanyNeId: "A", credentialVersionId: "v2" };
assert.equal((await previewNextEngineOrdersAction(window, bindingRef)).ok, false, "A changed credential version requires a fresh shop list");
assert.equal(state.__orderReads, 0, "No NE read before all gates and exact window pass");
state.__orderBinding = { ...state.__orderBinding, credentialVersionId: "v1" };
assert.deepEqual(await previewNextEngineOrdersAction(window, bindingRef), { ok: true,
  orders: [{ orderId: "3001", shopId: "2", importedAt: window.from, statusId: "20" }] });
assert.equal(state.__orderReads, 1);
state.__orderThrow = true;
const failed = await previewNextEngineOrdersAction(window, bindingRef);
assert.equal(failed.ok, false);
assert.ok(!JSON.stringify(failed).includes("private-value"));
console.log("Next Engine order preview action: ADMIN/staging/exact-window gate and safe result.");
