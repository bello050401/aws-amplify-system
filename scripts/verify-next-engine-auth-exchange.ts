import assert from "node:assert/strict";
import { exchangeNextEngineLaunch } from "../lib/listing/nextEngine/authExchange";

async function main() {
  const input = { uid: "test-uid", state: "test-state", clientId: "test-id", clientSecret: "synthetic-secret", expectedCompanyNeId: "test-company" };
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.next-engine.org/api_neauth");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("uid"), input.uid);
    assert.equal(body.get("state"), input.state);
    assert.equal(body.get("client_id"), input.clientId);
    assert.equal(body.get("client_secret"), input.clientSecret);
    return Response.json({ result: "success", uid: input.uid, company_ne_id: "test-company",
      access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
  };
  assert.deepEqual(await exchangeNextEngineLaunch(input, request), {
    uid: input.uid, companyNeId: "test-company", accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
  });
  await assert.rejects(exchangeNextEngineLaunch({ ...input, clientSecret: "" }, request));
  assert.equal(calls, 1);
  await assert.rejects(exchangeNextEngineLaunch(input, async () => { throw new Error("synthetic-secret"); }),
    error => error instanceof Error && !error.message.includes("synthetic-secret"));
  await assert.rejects(exchangeNextEngineLaunch(input, async () => Response.json({ result: "success", uid: "other",
    company_ne_id: "test-company", access_token: "a", refresh_token: "b" })));
  await assert.rejects(exchangeNextEngineLaunch(input, async () => Response.json({ result: "success", uid: input.uid,
    company_ne_id: "other-company", access_token: "a", refresh_token: "b" })));
  console.log("Next Engine auth exchange: official POST, server-only, strict response, redacted errors.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
