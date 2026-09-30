import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { NextEngineSettingsPanel } from "../app/inventory/(protected)/settings/NextEngineSettingsPanel";

const origin = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";

async function main(): Promise<void> {
  // tsx runs JSX outside Next's automatic JSX transform in this isolated test.
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const hidden = renderToStaticMarkup(React.createElement(NextEngineSettingsPanel, { state: "AWAITING_LAUNCH", diagnosticEnabled: false }));
  assert(!hidden.includes("/api/next-engine/diagnostic"), "disabled staging probe has no UI entry");
  const visible = renderToStaticMarkup(React.createElement(NextEngineSettingsPanel, { state: "AWAITING_LAUNCH", diagnosticEnabled: true }));
  assert(visible.includes('method="post"') && visible.includes('action="/api/next-engine/diagnostic"'));

  let posts = 0;
  let bodyBytes = -1;
  let postOrigin: string | undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.route("**/*", async route => {
      if (route.request().url() === `${origin}/inventory/settings`) {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: `<!doctype html><html><body>${visible}</body></html>` });
        return;
      }
      if (route.request().url() !== `${origin}/api/next-engine/diagnostic`) {
        await route.abort();
        return;
      }
      posts++;
      const browserRequest = route.request();
      bodyBytes = browserRequest.postDataBuffer()?.byteLength ?? 0;
      postOrigin = browserRequest.headers().origin;
      assert.equal(browserRequest.method(), "POST");
      assert.equal(new URL(browserRequest.url()).search, "");
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await page.goto(`${origin}/inventory/settings`);
    assert.equal(await page.locator("summary").count(), 1, "the settings page contains the manual probe entry");
    assert.equal(posts, 0, "page load cannot submit the probe");
    await page.getByText("合成値だけの接続診断を開く").click();
    assert.equal(posts, 0, "opening the manual disclosure cannot submit the probe");
    assert.equal(await page.locator('form[action="/api/next-engine/diagnostic"] [name]').count(), 0,
      "native form has no named controls to put into its body");
    await page.getByRole("button", { name: "合成診断を1回実行" }).click();
    assert.equal(posts, 1);
    assert.equal(bodyBytes, 0);
    assert.equal(postOrigin, origin);
    assert.equal(await page.locator("body").innerText(), '{"ok":true}');
    console.log("Next Engine diagnostic entry: manual disclosure and one native empty POST passed.");
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
