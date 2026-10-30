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
  let staff: Record<string, string> = { kind: "authorized", role: "EDITOR" };
  let payload: Record<string, unknown> | null = { sub: "staff-id", "cognito:groups": ["EDITOR", "MOBILE_HIDE_EC", "MOBILE_HIDE_SALES"] };
  let unavailable = false, authCalls = 0;
  const ports = {
    staff: async () => staff,
    auth: async () => {
      authCalls++;
      if (unavailable) throw new Error("Sensitive diagnostics must not escape");
      return payload ? { tokens: { accessToken: { payload } } } : {};
    },
  };
  const sources: Record<string, string> = {
    "next/server": 'export class NextResponse { static json(body, init={}) { return new Response(JSON.stringify(body), { ...init, headers: { "Content-Type":"application/json", ...init.headers } }); } }',
    "next/headers": 'export const cookies = () => ({});',
    "aws-amplify/auth/server": 'export const fetchAuthSession = () => globalThis.ports.auth();',
    "@/lib/amplify/userPoolServer": 'export const runWithUserPoolServerContext = ({operation}) => operation({});',
    "@/lib/amplify/requireInventoryUser": 'export const getInventorySessionStatus = () => globalThis.ports.staff();',
  };
  const bundled = await build({ stdin: { contents: 'export { GET } from "./app/api/mobile/session/route"; export { requireMobileFeature } from "./lib/mobile/session";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "isolated-auth", setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => sources[args.path] ? { path: args.path, namespace: "stub" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: sources[args.path], loader: "js" }));
  }}] });
  const module = { exports: {} as { GET(): Promise<Response>; requireMobileFeature(feature: string): Promise<{ ok: boolean; status?: number; error?: string }> } };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, ports, Response });
  for (const [kind, status] of [["signed-out", 401], ["signed-in-not-authorized", 403], ["temporarily-unavailable", 503]] as const) {
    staff = { kind }; authCalls = 0;
    assert.equal((await module.exports.GET()).status, status);
    assert.equal(authCalls, 0);
  }
  staff = { kind: "authorized", role: "EDITOR" };
  const response = await module.exports.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Vary"), "Cookie");
  assert.deepEqual(await response.json(), { owner: "staff-id", role: "EDITOR", features: { ecListing: false, sales: false } });
  for (const feature of ["ecListing", "sales", "unknown"]) {
    const decision = await module.exports.requireMobileFeature(feature);
    assert.equal(decision.ok, false); assert.equal(decision.status, 403);
  }
  payload = { sub: "admin-id", "cognito:groups": ["ADMIN", "MOBILE_HIDE_EC"] };
  staff = { kind: "authorized", role: "ADMIN" };
  assert.equal((await module.exports.requireMobileFeature("ecListing")).status, 403);
  assert.equal((await module.exports.requireMobileFeature("sales")).ok, true);
  payload = { sub: "staff-id", "cognito:groups": ["EDITOR"] };
  assert.equal((await module.exports.GET()).status, 403); // Conflicting sessions fail closed.
  payload = null; assert.equal((await module.exports.GET()).status, 401);
  unavailable = true;
  const failed = await module.exports.GET(); assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "AUTH_UNAVAILABLE" });
  console.log("PASS: mobile feature policy, restricted ADMIN, staff authentication, owner scoping, fail-closed server guard, redacted errors; no live changes.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
