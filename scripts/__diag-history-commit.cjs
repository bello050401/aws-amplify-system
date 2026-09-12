const { chromium } = require("playwright-core");
const TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
const BASE = "http://127.0.0.1:3100";
async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${TOKEN}`, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(`${BASE}/inventory/e2e-inv-7`, { waitUntil: "commit", timeout: 30000 });
  console.log("commit at", Date.now() - t0);
  await page.waitForSelector("text=基本情報", { timeout: 5000 });
  console.log("基本情報 visible at", Date.now() - t0);
  const bodyAtShell = await page.textContent("body");
  console.log("at shell-visible: statusId present?", bodyAtShell.includes("statusId"), " 読み込み中(ellipsis section fallback) present?", bodyAtShell.includes("読み込み中…"));
  await page.waitForFunction(() => document.body.textContent?.includes("statusId"), { timeout: 5000 });
  console.log("statusId visible at", Date.now() - t0);
  await browser.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
