import test from "node:test";
import assert from "node:assert/strict";
import { parseRefreshMaterial, refreshedCookies, refreshWebHttpSessionOnce, SHOPS_REFRESH_URL } from "./webHttpSessionRefresh.ts";
import { readRenewableRuntimeSession } from "./webHttpRuntime.ts";
import { sessionFromProvidedHar } from "./webHttpHarSession.ts";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";

const now = Date.parse("2026-10-14T14:00:00Z");
const jwt = (expiry, sub = "fixture-owner") => `e30.${Buffer.from(JSON.stringify({sub,iss:"fixture-issuer",exp:expiry/1000})).toString("base64url")}.fixture`;
const oldToken = jwt(now - 60_000), nextToken = jwt(now + 3_600_000);
const material = { cookieHeader: `id_token=${oldToken}; __cf_bm=fixture-cf`,
  refreshCookieHeader: "refresh_token=fixture-old-refresh; device_id=fixture-device; device_token=fixture-device-token",
  refreshExpiresAtMs: now + 86400_000, deviceExpiresAtMs: now + 365 * 86400_000 };
const cookieHeaders = [
  `id_token=${nextToken}; Path=/; Max-Age=3600; HttpOnly`,
  "refresh_token=fixture-new-refresh; Path=/auth/token/refresh; Max-Age=7776000; HttpOnly",
];
function mockFetch(changes = {}) {
  const calls = [];
  const fetchPort = async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, "manual");
    if (url === SHOPS_REFRESH_URL) {
      if (changes.throw) throw Error("private-session-value");
      assert.equal(init.method, "POST"); assert.equal(init.body, undefined);
      assert.equal(init.headers.Cookie.includes("id_token="), false);
      const headers = new Headers(); for (const value of changes.cookies ?? cookieHeaders) headers.append("Set-Cookie", value);
      return new Response("{}", { status: changes.httpStatus ?? 200, headers });
    }
    assert.equal(url, "https://mercari-shops.com/graphql");
    assert.equal(init.headers.Cookie.includes("refresh_token"), false);
    const request = JSON.parse(init.body);
    assert.ok(["Self", "OwnShops"].includes(request.operationName));
    return Response.json({data: request.operationName === "Self" ? {self:{accountId:"fixture-owner"}} :
      {ownShops:[{id:changes.wrongShop ? "other" : WEB_HTTP_SHOP_ID}]}});
  };
  return { calls, fetchPort };
}
test("observed refresh rotates both cookies, verifies shop and keeps secrets off GraphQL", async () => {
  const s = mockFetch(), result = await refreshWebHttpSessionOnce(material, s.fetchPort, () => now);
  assert.equal(result.expiresAtMs, now + 3_600_000);
  assert.equal(result.refreshCookieHeader.includes("fixture-new-refresh"), true);
  assert.equal(result.refreshCookieHeader.includes("fixture-old-refresh"), false);
  assert.equal(result.refreshExpiresAtMs, now + 90 * 86400_000);
  assert.equal(s.calls.length, 3);
});
test("redirect, missing cookies, changed owner, wrong shop and transport failure do not renew", async () => {
  for (const change of [{httpStatus:302}, {httpStatus:401}, {cookies:[]}, {wrongShop:true}, {throw:true},
    {cookies:[cookieHeaders[0].replace(nextToken,jwt(now+3_600_000,"other-owner")),cookieHeaders[1]]},
    {cookies:[cookieHeaders[0],cookieHeaders[1].replace("Path=/auth/token/refresh","Path=/")]},
    {cookies:[cookieHeaders[0]+"; Domain=other.example",cookieHeaders[1]]}]) {
    const s = mockFetch(change);
    assert.equal(await refreshWebHttpSessionOnce(material, s.fetchPort, () => now), null);
    assert.equal(s.calls.filter(url => url === SHOPS_REFRESH_URL).length, 1);
  }
  assert.equal(parseRefreshMaterial({...material,refreshExpiresAtMs:now},now),null);
  assert.equal(parseRefreshMaterial({...material,refreshCookieHeader:material.refreshCookieHeader+"; unknown=secret"},now),null);
  assert.equal(refreshedCookies(material,[...cookieHeaders,cookieHeaders[0]],now),null);
});
const record = (m = material, expiry = now - 60_000) => ({schemaVersion:1,shopId:WEB_HTTP_SHOP_ID,
  authenticatedAt:new Date(now-3600_000).toISOString(),expiresAt:new Date(expiry).toISOString(),opaqueMaterial:JSON.stringify(m)});
function storeScenario(options = {}) {
  let value = {versionId:"version-1",record:record()}, claimed = false, writes = 0;
  return { read:async()=>structuredClone(value),
    claim:async()=>{if(claimed)return false;claimed=true;return true},
    replace:async(old,id,next)=>{
      writes++; assert.equal(old,value.versionId);
      if(options.failSave)throw Error("storage-unavailable");
      value={versionId:id,record:next};
    }, get writes(){return writes}, set value(v){value=v}, get value(){return value} };
}
test("expired ID can renew once; concurrent callers and uncertain results cannot repeat refresh", async () => {
  const store=storeScenario(),s=mockFetch();
  const results=await Promise.all([readRenewableRuntimeSession(store,false,s.fetchPort,()=>now),
    readRenewableRuntimeSession(store,false,s.fetchPort,()=>now)]);
  assert.ok(results.some(x=>x?.expiresAtMs===now+3600_000));
  assert.equal(s.calls.filter(u=>u===SHOPS_REFRESH_URL).length,1);assert.equal(store.writes,1);
  assert.ok(await readRenewableRuntimeSession(store,false,s.fetchPort,()=>now));assert.equal(s.calls.length,3);
  for(const option of [{failSave:true},{lostResponse:true}]) {
    const one=storeScenario(option), network=mockFetch({throw:option.lostResponse});
    assert.equal(await readRenewableRuntimeSession(one,false,network.fetchPort,()=>now),null);
    assert.equal(await readRenewableRuntimeSession(one,false,network.fetchPort,()=>now),null);
    assert.equal(network.calls.filter(u=>u===SHOPS_REFRESH_URL).length,1);
  }
});
test("newer imported session wins over in-flight refresh",async()=>{
  const store=storeScenario(),s=mockFetch(), replacement=record({...material,cookieHeader:`id_token=${nextToken}`},now+3600_000);
  store.replace=async()=>{store.value={versionId:"manual-import",record:replacement};throw Error("compare-and-swap conflict")};
  const result=await readRenewableRuntimeSession(store,false,s.fetchPort,()=>now);
  assert.equal(result.cookieHeader,`id_token=${nextToken}`);assert.equal(store.value.versionId,"manual-import");
});
test("normal use renews before expiry; a fresh connection does not refresh unnecessarily",async()=>{
  const fresh=storeScenario(),s=mockFetch();
  fresh.value={versionId:"fresh",record:record({...material,cookieHeader:`id_token=${nextToken}`},now+3600_000)};
  assert.ok(await readRenewableRuntimeSession(fresh,false,s.fetchPort,()=>now));
  assert.equal(s.calls.length,0);
  assert.ok(await readRenewableRuntimeSession(fresh,true,s.fetchPort,()=>now));
  assert.equal(s.calls.length,3);
  const soon=storeScenario(),near=mockFetch();
  soon.value={versionId:"near-expiry",record:record({...material,cookieHeader:`id_token=${jwt(now+5*60_000)}`},now+5*60_000)};
  assert.equal((await readRenewableRuntimeSession(soon,false,near.fetchPort,()=>now)).expiresAtMs,now+3600_000);
  assert.equal(near.calls.length,3);
});
test("HAR import retains only the rotated refresh token and explicit device-cookie expiry",()=>{
  const capture={log:{entries:[
    {startedDateTime:new Date(now).toISOString(),request:{url:SHOPS_REFRESH_URL,method:"POST",cookies:[
      {name:"refresh_token",value:"fixture-old-refresh",path:"/auth/token/refresh",domain:"mercari-shops.com",expires:new Date(now+86400_000).toISOString()},
      ...["device_id","device_token"].map(name=>({name,value:"fixture-device",path:"/auth",domain:"mercari-shops.com",expires:new Date(now+365*86400_000).toISOString()}))]},
      response:{status:200,headers:cookieHeaders.map(value=>({name:"set-cookie",value}))}},
    {startedDateTime:new Date(now+1000).toISOString(),request:{url:"https://mercari-shops.com/graphql",method:"POST",
      headers:[{name:"cookie",value:`id_token=${nextToken}; unrelated=secret`}]}}
  ]}};
  const result=sessionFromProvidedHar(capture,now+2000);
  assert.equal(result.refreshCookieHeader.includes("fixture-new-refresh"),true);
  assert.equal(JSON.stringify(result).includes("fixture-old-refresh"),false);
  assert.equal(JSON.stringify(result).includes("unrelated"),false);
  capture.log.entries[0].response.headers=[];
  assert.equal(sessionFromProvidedHar(capture,now+2000).refreshCookieHeader,undefined);
});
