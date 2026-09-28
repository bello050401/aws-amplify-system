import assert from "node:assert/strict";
import { getNextEngineAppConfiguration } from "../lib/listing/nextEngine/appConfiguration";

assert.equal(getNextEngineAppConfiguration({}), null);
assert.equal(getNextEngineAppConfiguration({ NEXT_ENGINE_CLIENT_ID: "synthetic-id", NEXT_ENGINE_CLIENT_SECRET: "synthetic-secret" }), null);
assert.deepEqual(getNextEngineAppConfiguration({
  NEXT_ENGINE_CLIENT_ID: " synthetic-id ", NEXT_ENGINE_CLIENT_SECRET: " synthetic-secret ", NEXT_ENGINE_COMPANY_NE_ID: "123456",
}), { clientId: "synthetic-id", clientSecret: "synthetic-secret", expectedCompanyNeId: "123456" });
for (const invalid of [
  { NEXT_ENGINE_CLIENT_ID: "bad id", NEXT_ENGINE_CLIENT_SECRET: "synthetic-secret", NEXT_ENGINE_COMPANY_NE_ID: "123456" },
  { NEXT_ENGINE_CLIENT_ID: "synthetic-id", NEXT_ENGINE_CLIENT_SECRET: "bad secret", NEXT_ENGINE_COMPANY_NE_ID: "123456" },
  { NEXT_ENGINE_CLIENT_ID: "synthetic-id", NEXT_ENGINE_CLIENT_SECRET: "synthetic-secret", NEXT_ENGINE_COMPANY_NE_ID: "BELLO" },
]) assert.throws(() => getNextEngineAppConfiguration(invalid), error =>
  error instanceof Error && !error.message.includes("synthetic-secret"));
console.log("Next Engine app configuration: complete server-side settings required; invalid values redacted.");
