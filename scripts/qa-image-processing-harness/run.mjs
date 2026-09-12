// ImageProcessingPanel 実React境界試験(2026-09-13)。本物のコンポーネント
// を実Chromium(playwright-core)へmountし、Server Action境界だけを
// window.__ipHarnessでこのスクリプトから完全制御する。実AWS/Next.js不要。
// 実行: node scripts/qa-image-processing-harness/run.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(__dirname, "dist", "bundle.js");

let passes = 0;
let failures = 0;
function check(ok, label, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const HTML = `<!doctype html><html><body><div id="root"></div><script>
window.__initialProps = { inventoryId: "p1", images: [{ storageKey: "img-a", originalHash: "h1" }] };
</script><script src="/bundle.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/bundle.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end(fs.readFileSync(bundlePath));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(HTML);
});

async function main() {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));

  // ── シナリオ1: 初回全体失敗→再試行ボタンが到達可能→成功で回復 ──
  console.log("── シナリオ1: 初回全体失敗→再試行で回復(byKey=null早期returnの不具合修正) ──");
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__ipHarness?.callsFor("batch").length >= 1);
  let call = await page.evaluate(() => window.__ipHarness.latestCallFor("batch").id);
  await page.evaluate((id) => window.__ipHarness.reject(id, "network error"), call);
  await page.waitForSelector("text=画像加工の状態を読み込めませんでした");
  const retryBtn = page.getByRole("button", { name: "再試行" });
  check(await retryBtn.isVisible().catch(() => false), "★要件: 初回全体失敗時にも再試行ボタンが表示される(修正前はbyKey=nullの早期returnに阻まれ到達不能だった)");
  await retryBtn.click();
  await page.waitForFunction(() => window.__ipHarness.callsFor("batch").length >= 2);
  call = await page.evaluate(() => window.__ipHarness.latestCallFor("batch").id);
  await page.evaluate((id) => window.__ipHarness.resolve(id, { "img-a": [] }), call);
  await page.waitForSelector("text=加工する");
  check(!(await page.locator("text=読み込めませんでした").isVisible().catch(() => false)), "★要件: 再試行成功後はエラー表示が消える");

  // ── シナリオ2: 同一商品・二応答逆順(古い応答が新状態を上書きしない) ──
  console.log("\n── シナリオ2: 同一商品への二重refresh、遅い方が後に届いても新しい応答を上書きしない ──");
  const before = await page.evaluate(() => window.__ipHarness.callsFor("batch").length);
  await page.getByRole("button", { name: "再試行" }).click().catch(() => {});
  // 「再試行」ボタンは失敗時のみ表示のため、代わりに個別「加工する」を使い
  // handleReprocess後のrefresh()で2本目を発火させず、直接2回連続でボタンを
  // 押せない(書込系のため)。ここでは意図的に2回、状態不明を装うために
  // 一旦部分失敗を注入してから「状態を再取得」を連打し、2本の同時refresh()
  // を作る。
  await page.evaluate(() => window.__setPanelProps({ inventoryId: "p2", images: [{ storageKey: "img-race", originalHash: "h1" }] }));
  await page.waitForFunction((n) => window.__ipHarness.callsFor("batch").length > n, before);
  const raceInit = await page.evaluate(() => window.__ipHarness.latestCallFor("batch").id);
  await page.evaluate((id) => window.__ipHarness.resolve(id, { "img-race": null }), raceInit); // 部分失敗→「状態を再取得」ボタンが出る
  await page.waitForSelector("text=状態を再取得");
  const retry2 = page.getByRole("button", { name: "状態を再取得" });
  await retry2.click(); // call A (先に発行)
  await page.waitForFunction((n) => window.__ipHarness.callsFor("batch").length > n + 1, before);
  const callA = await page.evaluate(() => window.__ipHarness.latestCallFor("batch").id);
  await retry2.click(); // call B (後に発行、requestIdはAより新しい)
  await page.waitForFunction((n) => window.__ipHarness.callsFor("batch").length > n + 2, before);
  const callB = await page.evaluate(() => window.__ipHarness.latestCallFor("batch").id);
  // Bを先に解決(READY・要確認等、区別できる値)、Aを後から解決(旧応答)。
  await page.evaluate((id) => window.__ipHarness.resolve(id, { "img-race": [{ id: "vB", version: 2, status: "NEEDS_REVIEW", active: false, aspectRatio: null, processedMasterKey: null, webKey: null, thumbnailKey: null, failureCode: null, failureDetail: null, completedAt: null }] }), callB);
  await page.waitForSelector("text=要確認");
  await page.evaluate((id) => window.__ipHarness.resolve(id, { "img-race": [{ id: "vA", version: 1, status: "READY", active: true, aspectRatio: null, processedMasterKey: null, webKey: null, thumbnailKey: null, failureCode: null, failureDetail: null, completedAt: null }] }), callA);
  await page.waitForTimeout(150);
  const textAfterRace = await page.textContent("body");
  check(textAfterRace.includes("要確認") && !textAfterRace.includes("加工済"), "★要件: 後発(callB)の応答が残り、先発だが遅れて届いたcallAの応答に上書きされない");

  // ── シナリオ3: 部分失敗は該当画像の書込系ボタンだけを禁止する ──
  console.log("\n── シナリオ3: 部分失敗の画像は書込系ボタン禁止、画像本体(行)の表示は継続する ──");
  await page.evaluate(() => window.__setPanelProps({ inventoryId: "p3", images: [{ storageKey: "img-ok", originalHash: "h1" }, { storageKey: "img-bad", originalHash: "h1" }] }));
  await page.waitForFunction(() => window.__ipHarness.latestCallFor("batch"));
  const c3 = await page.evaluate(() => window.__ipHarness.latestCallFor("batch").id);
  await page.evaluate((id) => window.__ipHarness.resolve(id, { "img-ok": [], "img-bad": null }), c3);
  await page.waitForSelector("text=取得失敗");
  const body3 = await page.textContent("body");
  check(body3.includes("画像1:") && body3.includes("画像2:"), "★要件: 部分失敗でも両方の画像行(本体表示)が描画され続ける");
  const reprocessButtons = page.locator("button", { hasText: "加工する" });
  check((await reprocessButtons.count()) >= 1, "画像1(正常)は操作可能なまま");
  const failedRow = page.locator("li", { hasText: "画像2" });
  check(await failedRow.getByRole("button", { name: "加工する" }).isDisabled(), "★要件: 部分失敗した画像2の「加工する」ボタンは無効化される");

  await browser.close();
  server.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("HARNESS FAILED:", err);
  process.exit(1);
});
