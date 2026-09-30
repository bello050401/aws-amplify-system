import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createNextEngineCallbackHandlers } from "../lib/listing/nextEngine/callbackHandler";
import { completeNextEngineLaunch } from "../lib/listing/nextEngine/completeLaunch";

const origin = "https://staging.example.test";
const callback = `${origin}/api/next-engine/callback?uid=synthetic-uid&state=synthetic-state`;
const config = { clientId: "synthetic-id", clientSecret: "synthetic-secret", expectedCompanyNeId: "123456", credentialVersionId: "version-a" };
const pair = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };
let exchanges = 0;
let saved = 0;
let postOrigin: string | undefined;
let postReferer: string | undefined;
let actualPostStatus: number | undefined;
const handlers = createNextEngineCallbackHandlers({
  origin: () => origin,
  isAdmin: async () => true,
  configuration: async () => config,
  complete: completeNextEngineLaunch,
  preflight: async () => null,
  exchange: async () => { exchanges++; return pair; },
  save: async () => { saved++; },
  readBack: async () => pair,
});

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/api/next-engine/callback?*", async route => {
      const browserRequest = route.request();
      const headers = browserRequest.headers();
      const request = new Request(browserRequest.url(), { method: browserRequest.method(), headers });
      if (browserRequest.method() === "GET") {
        const response = await handlers.GET(request);
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      } else {
        postOrigin = headers.origin;
        postReferer = headers.referer;
        const response = await handlers.POST(request);
        actualPostStatus = response.status;
        // Keep the synthetic browser local; the real response is checked above.
        await route.fulfill({ status: 200, contentType: "text/plain", body: "done" });
      }
    });
    await page.goto(callback);
    await page.getByRole("button", { name: "接続する" }).click();
    assert.equal(postOrigin, origin);
    assert.equal(postReferer, `${origin}/`);
    assert(!postReferer?.includes("uid=") && !postReferer?.includes("state="));
    assert.equal(actualPostStatus, 303);
    assert.equal(exchanges, 1);
    assert.equal(saved, 1);
    console.log("Next Engine native form: same-origin POST, origin-only Referer and one exchange passed.");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
