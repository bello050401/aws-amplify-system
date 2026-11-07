import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { mobileFeaturesForGroups } from "../lib/mobile/accessPolicy";

async function main() {
  for (const role of ["ADMIN", "EDITOR", "VIEWER"]) {
    assert.deepEqual(mobileFeaturesForGroups([role]), { ecListing: true, sales: true });
    assert.deepEqual(mobileFeaturesForGroups([role, "MOBILE_HIDE_EC"]), { ecListing: false, sales: true });
    assert.deepEqual(mobileFeaturesForGroups([role, "MOBILE_HIDE_SALES"]), { ecListing: true, sales: false });
    assert.deepEqual(mobileFeaturesForGroups([role, "MOBILE_HIDE_EC", "MOBILE_HIDE_SALES"]), { ecListing: false, sales: false });
  }
  for (const groups of [undefined, null, "ADMIN", [], ["Admins"], ["MOBILE_HIDE_EC"], ["ADMIN", false]]) {
    assert.deepEqual(mobileFeaturesForGroups(groups), { ecListing: false, sales: false });
  }
  let payload: Record<string, unknown> | null = { sub: "staff-id", "cognito:groups": ["EDITOR", "MOBILE_HIDE_EC", "MOBILE_HIDE_SALES"] };
  let unavailable = false, authCalls = 0;
  const ports = {
    auth: async () => {
      authCalls++;
      if (unavailable) throw Object.assign(new Error("Sensitive diagnostics must not escape"),{name:'TooManyRequestsException'});
      return payload ? { tokens: { accessToken: { payload } } } : {};
    },
  };
  const sources: Record<string, string> = {
    "next/server": 'export class NextResponse { static json(body, init={}) { return new Response(JSON.stringify(body), { ...init, headers: { "Content-Type":"application/json", ...init.headers } }); } }',
    "next/headers": 'export const cookies = () => ({});',
    "aws-amplify/auth/server": 'export const fetchAuthSession = () => globalThis.ports.auth();',
    "@/lib/amplify/userPoolServer": 'export const runWithUserPoolServerContext = ({operation}) => operation({});',
    "./userPoolServer": 'export const runWithUserPoolServerContext = ({operation}) => operation({});',
    "./requestCache": 'export const requestCache = fn => fn;',
  };
  const bundled = await build({ stdin: { contents: 'export { GET } from "./app/api/mobile/session/route"; export { requireMobileFeature } from "./lib/mobile/session";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "isolated-auth", setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => sources[args.path] ? { path: args.path, namespace: "stub" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: sources[args.path], loader: "js" }));
  }}] });
  const module = { exports: {} as { GET(): Promise<Response>; requireMobileFeature(feature: string): Promise<{ ok: boolean; status?: number; error?: string }> } };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, ports, Response, process:{env:{NODE_ENV:'production'}} });
  for (const [input, status] of [[null,401],[{sub:'x','cognito:groups':['Other']},403],[{sub:'x','cognito:groups':'ADMIN'},403],[{sub:'x','cognito:groups':['ADMIN',false]},403]] as const) {
    payload=input;authCalls=0;
    assert.equal((await module.exports.GET()).status, status);
    assert.equal(authCalls, 1,'Unauthenticated and malformed access still require exactly one credential verification');
  }
  payload={sub:'staff-id','cognito:groups':['EDITOR','MOBILE_HIDE_EC','MOBILE_HIDE_SALES']};authCalls=0;
  const response = await module.exports.GET();
  assert.equal(authCalls,1,'Authorized startup must not repeat Cognito session verification');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Vary"), "Cookie");
  assert.deepEqual(await response.json(), { owner: "staff-id", role: "EDITOR", features: { ecListing: false, sales: false } });
  for (const feature of ["ecListing", "sales", "unknown"]) {
    const decision = await module.exports.requireMobileFeature(feature);
    assert.equal(decision.ok, false); assert.equal(decision.status, 403);
  }
  payload = { sub: "admin-id", "cognito:groups": ["ADMIN", "MOBILE_HIDE_EC"] };
  assert.equal((await module.exports.requireMobileFeature("ecListing")).status, 403);
  assert.equal((await module.exports.requireMobileFeature("sales")).ok, true);
  payload = { "cognito:groups": ["EDITOR"] };
  assert.equal((await module.exports.GET()).status, 401); // A group without an authenticated owner cannot access data.
  payload = null; assert.equal((await module.exports.GET()).status, 401);
  unavailable = true;
  const failed = await module.exports.GET(); assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "AUTH_UNAVAILABLE" });
  console.log("PASS: mobile feature policy, restricted ADMIN, staff authentication, owner scoping, fail-closed server guard, redacted errors; no live changes.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
