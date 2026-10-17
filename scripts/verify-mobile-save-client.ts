import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { draftFor, type InventoryItem } from "../mobile/src/domain/inventory";
import { previewItems } from "../mobile/src/preview/fixture";
import type { SaveRequest } from "../mobile/src/domain/editor";

async function main(platform: "ios" | "web") {
  const item = { ...previewItems[0], detailLoadedAt: "2026-10-17T01:00:00.000Z" };
  const request: SaveRequest = { id: item.id, expectedUpdatedAt: item.updatedAt, mutationId: "00000000-0000-4000-8000-000000000001", draft: draftFor(item) };
  let enabled = true, status = 200, corrupt = "", disconnected = false, authUnavailable = false;
  let calls: SaveRequest[] = [];
  const ports = {
    auth: async () => {
      if (authUnavailable) throw Error("synthetic auth unavailable");
      return { tokens: { accessToken: { payload: { username: "synthetic" }, toString: () => "synthetic.access.signature" }, idToken: { toString: () => "synthetic.id.signature" } } };
    },
    fetch: async (url: string, init: RequestInit) => {
      if (url.endsWith("/config")) return new Response(JSON.stringify({ auth: { userPoolId: "synthetic-pool", userPoolClientId: "synthetic-client" }, contractVersion: 1, writesEnabled: enabled }));
      assert.ok(url.endsWith(`/inventory/${request.id}`)); assert.equal(init.method, "PATCH"); assert.equal(init.redirect, "error");
      const headers = new Headers(init.headers); assert.equal(headers.get("X-Bello-Mobile"), "1"); assert.equal(headers.get("Content-Type"), "application/json");
      assert.equal(init.credentials, "same-origin");
      assert.equal(headers.has("Cookie"), platform === "ios");
      if (platform === "ios") assert.equal(headers.get("Cookie")?.includes("refreshToken"), false);
      if (platform === "web") assert.ok(url.startsWith("https://bello.example/"));
      calls.push(JSON.parse(init.body as string));
      if (disconnected) throw Error("synthetic connection lost");
      const payload = { owner: corrupt === "owner" ? "another" : "synthetic-owner", mutationId: corrupt === "mutation" ? "wrong" : request.mutationId,
        item: corrupt === "item" ? { ...item, id: "other" } : corrupt === "version" ? { ...item, updatedAt: null } : item };
      return new Response(corrupt === "json" ? "not json" : JSON.stringify(payload), { status });
    },
  };
  const sources: Record<string, string> = {
    "react-native": `export const Platform = {OS:${JSON.stringify(platform)}};`,
    "aws-amplify": 'export const Amplify = {configure: () => {}};',
    "aws-amplify/auth": 'export const fetchAuthSession = () => globalThis.ports.auth(); export const getCurrentUser = async () => ({userId:"synthetic-owner"});',
    "aws-amplify/auth/cognito": 'export const cognitoUserPoolsTokenProvider = {setKeyValueStorage: () => {}};',
    "@react-native-async-storage/async-storage": 'export default {setItem:async()=>{},getItem:async()=>null};',
    "./secureTokenStorage": 'export class SecureTokenStorage { async clear() {} }',
  };
  const bundled = await build({ entryPoints: ["mobile/src/runtime/service.ts"], bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "isolated-native-service", setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => sources[args.path] ? { path: args.path, namespace: "stub" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: sources[args.path], loader: "js" }));
  }}] });
  const module = { exports: {} as { configureMobileAuth(online: boolean): Promise<void>; saveInventory(request: SaveRequest): Promise<InventoryItem> } };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, ports, fetch: ports.fetch, AbortController, setTimeout, clearTimeout, window: {location:{origin:"https://bello.example"}} });
  await module.exports.configureMobileAuth(true);
  assert.equal((await module.exports.saveInventory(request)).id, item.id); assert.deepEqual(calls, [request]);
  for (const [httpStatus, kind] of [[401, "unauthorized"], [403, "forbidden"], [409, "conflict"], [422, "server"], [503, "uncertain"]] as const) {
    status = httpStatus;
    await assert.rejects(module.exports.saveInventory(request), (error: any) => error.kind === kind);
  }
  status = 200;
  for (const type of ["owner", "mutation", "item", "version", "json"]) {
    corrupt = type;
    await assert.rejects(module.exports.saveInventory(request), (error: any) => error.kind === "uncertain");
  }
  corrupt = ""; disconnected = true; calls = [];
  await assert.rejects(module.exports.saveInventory(request), (error: any) => error.kind === "uncertain");
  await Promise.resolve(); assert.equal(calls.length, 1); // No automatic retry.
  disconnected = false; await module.exports.saveInventory(request); assert.deepEqual(calls, [request, request]);
  calls = []; authUnavailable = true;
  await assert.rejects(module.exports.saveInventory(request), (error: any) => error.kind === "unauthorized"); assert.equal(calls.length, 0);
  authUnavailable = false; enabled = false; await module.exports.configureMobileAuth(true);
  await assert.rejects(module.exports.saveInventory(request), (error: any) => error.kind === "forbidden"); assert.equal(calls.length, 0);
  console.log(`PASS: ${platform} BELLO save request, identity/receipt validation, errors, no automatic retry and disabled writes; simulated transport only.`);
}
main("ios").then(() => main("web")).catch(error => { console.error(error); process.exitCode = 1; });
