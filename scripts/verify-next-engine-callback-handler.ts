import assert from "node:assert/strict";
import { configuredNextEngineOrigin, createNextEngineCallbackHandlers } from "../lib/listing/nextEngine/callbackHandler";
import { completeNextEngineLaunch } from "../lib/listing/nextEngine/completeLaunch";

const origin = "https://staging.example.test";
const callback = `${origin}/api/next-engine/callback?uid=synthetic-uid&state=synthetic-state`;
const config = { clientId: "synthetic-id", clientSecret: "synthetic-secret", expectedCompanyNeId: "123456", credentialVersionId: "version-a" };
const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };
let admin = true;
let current = config;
let exchanges = 0;
let writes = 0;
let readBack = false;
let launchValid = true;
const handlers = createNextEngineCallbackHandlers({
  origin: () => origin,
  isAdmin: async () => admin,
  configuration: async () => current,
  complete: completeNextEngineLaunch,
  preflight: async () => null,
  exchange: async () => { exchanges++; if (!launchValid) throw new Error("synthetic expired or replayed state"); return tokens; },
  save: async () => { writes++; readBack = true; },
  readBack: async () => readBack ? tokens : null,
});
const request = (method: "GET" | "POST", headerOrigin?: string) => new Request(callback, {
  method, headers: headerOrigin === undefined ? {} : { Origin: headerOrigin },
});
const secured = (response: Response, policy = "no-referrer") => {
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("referrer-policy"), policy);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert(!response.headers.get("location")?.includes("uid="));
};

async function main() {
  assert.equal(configuredNextEngineOrigin(origin), origin);
  for (const invalid of ["http://staging.example.test", `${origin}/path`, `${origin}/`, "null", ""]) assert.equal(configuredNextEngineOrigin(invalid), null);

  const get = await handlers.GET(request("GET"));
  secured(get, "strict-origin");
  assert.equal(get.status, 200);
  const html = await get.text();
  for (const secret of ["synthetic-uid", "synthetic-state", "synthetic-id", "synthetic-secret", "synthetic-access"]) {
    assert(!html.includes(secret));
  }
  assert.match(html, /<form method="post">/);
  assert.equal(exchanges, 0);
  assert.equal(writes, 0);

  for (const headerOrigin of [undefined, "null", "https://other.example.test"]) {
    const response = await handlers.POST(request("POST", headerOrigin));
    secured(response);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${origin}/inventory/settings`);
  }
  assert.equal(exchanges, 0, "Missing, null or foreign Origin cannot consume state");

  admin = false;
  const denied = await handlers.POST(request("POST", origin));
  secured(denied);
  assert.equal(denied.headers.get("location"), `${origin}/inventory/login`);
  assert.equal(exchanges, 0);
  admin = true;

  const success = await handlers.POST(request("POST", origin));
  secured(success);
  assert.equal(success.status, 303);
  assert.equal(success.headers.get("location"), `${origin}/inventory/settings`);
  assert.equal(exchanges, 1);
  assert.equal(writes, 1);

  launchValid = false;
  const expired = await handlers.POST(request("POST", origin));
  secured(expired);
  assert.equal(writes, 1, "Expired or replayed NE state must not save tokens");
  launchValid = true;

  current = { ...config, credentialVersionId: "version-b" };
  await handlers.POST(request("POST", origin));
  assert.equal(writes, 2, "New current version can connect when it is stable");
  console.log("Next Engine callback: GET confirmation, Origin and ADMIN gate, no secret echo, safe redirect passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
