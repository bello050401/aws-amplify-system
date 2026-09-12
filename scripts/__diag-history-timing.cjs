const { chromium } = require("playwright-core");
const TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
const BASE = "http://127.0.0.1:3100";
async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([{ name: "__inv_e2e_role", value: `ADMIN:${TOKEN}`, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const t0 = Date.now();
  const resp = await page.goto(`${BASE}/inventory/e2e-inv-7`, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("status", resp.status(), "elapsed(domcontentloaded)", Date.now() - t0);
  const bodyNow = await page.textContent("body");
  console.log("contains 基本情報:", bodyNow.includes("基本情報"));
  console.log("contains 読み込み中:", bodyNow.includes("読み込み中"));
  console.log("contains 更新履歴:", bodyNow.includes("更新履歴"));
  console.log("contains statusId:", bodyNow.includes("statusId"));
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(500);
    const t = await page.textContent("body");
    console.log(`+${(i + 1) * 500}ms  読み込み中:${t.includes("読み込み中")}  statusId:${t.includes("statusId")}  変更履歴はまだ:${t.includes("変更履歴はまだ")}`);
  }
  await browser.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
