// 手動repro: 直接3100へアクセス(プロキシ無し)して/inventory/e2e-inv-1の
// pageerror/console.errorを収集する。使い捨てQAスクリプト。
const { chromium } = require("playwright-core");

const TOKEN = "e2e-local-test-token-not-a-real-secret-32c";

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    { name: "__inv_e2e_role", value: `ADMIN:${TOKEN}`, domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (res) => {
    if (res.status() >= 400) console.log("[HTTP >=400]", res.status(), res.url());
  });

  await page.goto("http://127.0.0.1:3100/inventory/e2e-inv-1", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(3000); // 遅延描画(medium 1.2s delay等)を待つ
  const bodyText = await page.textContent("body");
  const hasErrorBoundary = bodyText.includes("画面の表示中に問題が発生しました");
  console.log("=== DIRECT 3100 RESULT ===");
  console.log("hasErrorBoundary:", hasErrorBoundary);
  console.log("pageErrors:", JSON.stringify(pageErrors, null, 2));
  console.log("consoleErrors:", JSON.stringify(consoleErrors, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error("REPRO SCRIPT FAILED:", err);
  process.exit(1);
});
