// 手動repro: GET専用proxy(3114→3100)経由でアクセスし、pageerror/
// error boundary文言の有無を直接アクセス版と比較する。使い捨てQA
// スクリプト。
const { chromium } = require("playwright-core");

const TOKEN = "e2e-local-test-token-not-a-real-secret-32c";

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${TOKEN}`, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (res) => {
    if (res.status() >= 400) console.log("[HTTP >=400]", res.status(), res.request().method(), res.url());
  });

  await page.goto("http://127.0.0.1:3115/inventory/e2e-inv-1", { waitUntil: "networkidle", timeout: 30000 }).catch((e) => {
    console.log("[goto error]", e.message);
  });
  await page.waitForTimeout(4000);
  const bodyText = await page.textContent("body").catch(() => "<no body>");
  const hasErrorBoundary = bodyText.includes("画面の表示中に問題が発生しました");
  console.log("=== PROXY 3115 RESULT ===");
  console.log("hasErrorBoundary:", hasErrorBoundary);
  console.log("bodyText snippet:", bodyText.slice(0, 300));
  console.log("pageErrors:", JSON.stringify(pageErrors, null, 2));
  console.log("consoleErrors:", JSON.stringify(consoleErrors, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error("REPRO SCRIPT FAILED:", err);
  process.exit(1);
});
