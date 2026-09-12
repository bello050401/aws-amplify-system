// 詳細履歴の実境界試験(2026-09-12、task_a748ee69c990317c24)。
// scripts/qa-run-e2e-dev.cjs で起動したdevサーバー(INVENTORY_E2E_FIXTURES=1、
// INVENTORY_E2E_HISTORY_FAILUREなし)に対して、実ブラウザ(Playwright)経由で
// 商品詳細ページの更新履歴セクションの実配線を確認する使い捨てQAスクリプト。
// scripts/qa-manual-repro-direct.cjs(画像段階読込QA)と同じ認証bypassパターン。
const { chromium } = require("playwright-core");

const TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
const BASE = "http://127.0.0.1:3100";

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

async function newAuthedPage(browser, role = "ADMIN") {
  const context = await browser.newContext();
  await context.addCookies([{ name: "__inv_e2e_role", value: `${role}:${TOKEN}`, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  return { context, page };
}

async function main() {
  const browser = await chromium.launch();

  // ウォームアップ: `next dev`は各ルートを初回リクエスト時に初めて
  // コンパイルする(実測: 未コンパイル状態で/inventory/[id]への初回GETは
  // ページ本体の2秒遅延とは無関係に4〜6秒かかる——本番ビルドでは
  // 発生しない、この使い捨てdevサーバー固有のコスト)。シナリオ1の
  // 「本体は履歴の2秒遅延より先に表示される」計測をこのコンパイル時間
  // で汚染しないよう、計測を始める前に一度だけ同じルートへ触れて
  // コンパイル済みにしておく(実際のP1の効果とは無関係な変数を消す)。
  {
    const { context, page } = await newAuthedPage(browser);
    await page.goto(`${BASE}/inventory/e2e-inv-1`, { waitUntil: "networkidle", timeout: 60000 });
    await context.close();
  }

  // ── シナリオ1: 本体先行描画(e2e-inv-7、履歴取得2秒遅延) ──────────
  console.log("── シナリオ1: 本体は履歴を待たずに先に表示される ─────────────");
  {
    // 実境界試験レビュー補正(2026-09-12): このページ全体が1本のHTTP
    // レスポンス(React Server Componentsのストリーミング応答)として
    // 返るため、`waitUntil: "domcontentloaded"`はブラウザがストリーム
    // 全体(=履歴の2秒遅延ぶんも含む)を受信し終わるまで解決しない
    // ——「domcontentloadedの時点でstatusIdが見えている」という一見
    // 矛盾する結果になり、本体が先に見えているかを一切検証できていな
    // かった(scripts/__diag-history-streaming.cjsの生HTTPチャンク計測
    // で確認: 本体側の21件のチャンクは送信開始t=0msに届くのに対し、
    // 履歴側の最終チャンクはt≈2000ms)。`waitUntil: "commit"`
    // (ナビゲーションがコミットされ次第、レスポンス全体を待たずに
    // 解決する)に変えることで、実ブラウザの漸進的レンダリングを
    // Playwright側でも正しく観測できる。
    const { context, page } = await newAuthedPage(browser);
    const navStart = Date.now();
    await page.goto(`${BASE}/inventory/e2e-inv-7`, { waitUntil: "commit", timeout: 30000 });
    // 本体(基本情報の見出し)が2秒の履歴遅延より先に見えることを確認する。
    await page.waitForSelector("text=基本情報", { timeout: 1500 });
    const bodyVisibleMs = Date.now() - navStart;
    check(bodyVisibleMs < 1500, "★要件: 本体(基本情報)が履歴の2秒遅延より先に表示される", `${bodyVisibleMs}ms`);

    const bodyAtShell = await page.textContent("body");
    check(bodyAtShell.includes("読み込み中…"), "本体表示の時点でSuspense fallback「読み込み中…」が出ている");
    check(!bodyAtShell.includes("statusId"), "本体表示の時点では更新履歴(statusId)はまだ届いていない");

    await page.waitForFunction(() => document.body.textContent?.includes("statusId"), { timeout: 5000 });
    const historyVisibleMs = Date.now() - navStart;
    check(historyVisibleMs >= 1900, "★要件: 更新履歴は約2秒の遅延を経てから表示される(先行表示のフリではない)", `${historyVisibleMs}ms`);
    await context.close();
  }

  // ── シナリオ2: 空表示と失敗表示の区別(e2e-inv-6は0件) ──────────
  console.log("\n── シナリオ2: 実0件は「まだありません」であって失敗表示ではない ──");
  {
    const { context, page } = await newAuthedPage(browser);
    await page.goto(`${BASE}/inventory/e2e-inv-6`, { waitUntil: "networkidle", timeout: 30000 });
    const text = await page.textContent("body");
    check(text.includes("変更履歴はまだありません"), "★要件: 0件は「変更履歴はまだありません」");
    check(!text.includes("読み込めませんでした"), "★要件: 0件は失敗表示(読み込めませんでした)にならない");
    await context.close();
  }

  // ── シナリオ3: 再試行復帰(e2e-inv-8はSSR初回失敗→retryで成功) ──────
  console.log("\n── シナリオ3: 初回失敗→再試行で回復する ─────────────────────");
  {
    const { context, page } = await newAuthedPage(browser);
    await page.goto(`${BASE}/inventory/e2e-inv-8`, { waitUntil: "networkidle", timeout: 30000 });
    const beforeRetryText = await page.textContent("body");
    check(beforeRetryText.includes("変更履歴を読み込めませんでした"), "★要件: SSR初回は失敗表示+再試行ボタン");
    const retryButton = page.getByRole("button", { name: "再試行" });
    check(await retryButton.isVisible().catch(() => false), "再試行ボタンが表示されている");
    await retryButton.click();
    await page.waitForFunction(() => document.body.textContent?.includes("statusId") || document.body.textContent?.includes("編集"), { timeout: 5000 });
    const afterRetryText = await page.textContent("body");
    check(!afterRetryText.includes("読み込めませんでした"), "★要件: 再試行後は失敗表示が消える");
    check(afterRetryText.includes("statusId") || afterRetryText.includes("編集"), "★要件: 再試行後は実際の履歴テーブルが表示される");
    await context.close();
  }

  // ── シナリオ4: 別商品への切替で旧状態を引き継がない ──────────────
  console.log("\n── シナリオ4: 別商品へ移動しても前の商品のエラー状態が残らない ──");
  {
    const { context, page } = await newAuthedPage(browser);
    // まずe2e-inv-9(常に失敗、回復しない)を開いて失敗表示のままにする。
    await page.goto(`${BASE}/inventory/e2e-inv-9`, { waitUntil: "networkidle", timeout: 30000 });
    const invalid9 = await page.textContent("body");
    check(invalid9.includes("読み込めませんでした"), "前提: inv-9は常に失敗のまま");
    // 別商品(e2e-inv-1、通常1件)へ直接遷移する。
    await page.goto(`${BASE}/inventory/e2e-inv-1`, { waitUntil: "networkidle", timeout: 30000 });
    const invalid1 = await page.textContent("body");
    check(!invalid1.includes("読み込めませんでした"), "★要件: 別商品(e2e-inv-1)は前の商品の失敗表示を引き継がない");
    check(invalid1.includes("statusId") || invalid1.includes("編集"), "別商品は自分の実データを表示する");
    await context.close();
  }

  // ── シナリオ5: 遅い旧応答が新しい商品へ紛れ込まない ──────────────
  console.log("\n── シナリオ5: 遅延中に別商品へ切替えても古い応答が紛れ込まない ──");
  {
    const { context, page } = await newAuthedPage(browser);
    // シナリオ1と同じ理由(waitUntil:"domcontentloaded"はストリーム全体
    // ——履歴の2秒遅延ぶんも含む——を待ってしまい、この後の300ms待ちの
    // 時点でe2e-inv-7の応答が既に完了してしまっていた)でcommitに変える。
    await page.goto(`${BASE}/inventory/e2e-inv-7`, { waitUntil: "commit", timeout: 30000 });
    await page.waitForSelector("text=基本情報", { timeout: 1500 });
    // e2e-inv-7の履歴取得(2秒)が終わる前に、空(0件)のe2e-inv-6へ移動する。
    await page.waitForTimeout(300);
    await page.goto(`${BASE}/inventory/e2e-inv-6`, { waitUntil: "networkidle", timeout: 30000 });
    // e2e-inv-7の遅延分(2秒)が経過してもe2e-inv-6の表示が上書きされないことを確認する。
    await page.waitForTimeout(2200);
    const text = await page.textContent("body");
    check(text.includes("変更履歴はまだありません"), "★要件: 古い商品(e2e-inv-7)の遅延応答が後から届いても現在の商品(e2e-inv-6、0件)の表示を上書きしない");
    check(!text.includes("読み込めませんでした"), "誤った失敗表示に化けてもいない");
    await context.close();
  }

  // ── シナリオ6: 未認証は商品詳細ページへ到達できない ──────────────
  console.log("\n── シナリオ6: 未認証はログインへリダイレクトされる ─────────────");
  {
    const context = await browser.newContext(); // Cookie無し
    const page = await context.newPage();
    await page.goto(`${BASE}/inventory/e2e-inv-1`, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    const url = page.url();
    check(url.includes("/inventory/login"), "★要件: 未認証は/inventory/loginへリダイレクトされる", url);
    await context.close();
  }

  // ── シナリオ7: VIEWER/EDITORでも更新履歴の表示・再試行が機能する ──
  // getInventoryHistoryAction(app/actions/inventory.ts)はcanEditInventory
  // (ADMIN/EDITOR限定)ではなくgetInventoryRole()の真偽だけを見る——
  // 更新履歴の閲覧・再試行は編集権限とは無関係な操作だという設計
  // (lib/amplify/requireInventoryUser.ts参照)。「役割ごとに挙動が
  // 変わらない(=矛盾しない)」ことを確認するのが目的であって、
  // e2e-inv-9(常に失敗)を使うため再試行後も回復はしない——ADMINで
  // 使ったe2e-inv-8(1回だけ失敗して回復する)はプロセス内でシナリオ3が
  // 既に消費済みで、役割を跨いだ独立シナリオには使えない。ここで見るのは
  // 「VIEWER/EDITORでもページに到達でき(ログインへ弾かれない)、
  // 通常表示・再試行クリックのいずれもADMINと同じ失敗UIのまま一貫して
  // 振る舞う(役割による差・認可エラーへの化けが無い)」こと。
  console.log("\n── シナリオ7: VIEWER/EDITORでも更新履歴の表示・再試行が機能する ──");
  for (const role of ["VIEWER", "EDITOR"]) {
    const { context, page } = await newAuthedPage(browser, role);
    await page.goto(`${BASE}/inventory/e2e-inv-1`, { waitUntil: "networkidle", timeout: 30000 });
    const normalText = await page.textContent("body");
    check(!page.url().includes("/inventory/login"), `★要件: ${role}は在庫詳細ページへログインへ弾かれずに到達する`);
    check(normalText.includes("statusId") || normalText.includes("編集"), `★要件: ${role}でも通常の更新履歴テーブルが表示される`);

    await page.goto(`${BASE}/inventory/e2e-inv-9`, { waitUntil: "networkidle", timeout: 30000 });
    const before = await page.textContent("body");
    check(before.includes("変更履歴を読み込めませんでした"), `${role}でもADMINと同じ失敗表示が出る(認可エラー等の別表示に化けない)`);
    const retryButton = page.getByRole("button", { name: "再試行" });
    await retryButton.click();
    await page.waitForTimeout(300);
    const after = await page.textContent("body");
    check(!page.url().includes("/inventory/login"), `★要件: ${role}が再試行を押してもログインへ弾かれない(Server Actionの認可が通っている)`);
    check(after.includes("変更履歴を読み込めませんでした"), `${role}の再試行後も(e2e-inv-9は回復しない仕様どおり)同じ失敗表示のまま`);
    await context.close();
  }

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("QA SCRIPT FAILED:", err);
  process.exit(1);
});
