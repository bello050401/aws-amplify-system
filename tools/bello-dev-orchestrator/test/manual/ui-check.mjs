/**
 * ダッシュボードの画面確認 (Playwright)。
 *
 * PC 幅と iPhone 相当幅の両方で、4 つの画面すべてについて
 *   - 横スクロールが出ていないか
 *   - 文字が切れていないか（要素が親からはみ出していないか）
 *   - 主要な操作要素が触れる大きさか、他の要素に隠れていないか
 * を機械的に確認し、スクリーンショットを保存する。
 *
 * 使い方（Orchestrator を起動した状態で）:
 *   node test/manual/ui-check.mjs
 *   node test/manual/ui-check.mjs --out C:\path\to\screenshots
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "@playwright/test";

const BASE = process.env.BELLO_DASHBOARD_URL || "http://127.0.0.1:4319";
const outIndex = process.argv.indexOf("--out");
const OUT_DIR =
  outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : path.join(process.env.LOCALAPPDATA || ".", "BELLO", "dev-orchestrator", "evidence", "ui");

const VIEWS = [
  { key: "home", label: "ホーム" },
  { key: "history", label: "開発履歴" },
  { key: "add", label: "指示を追加" },
  { key: "settings", label: "設定" },
];

const PROFILES = [
  { name: "pc", label: "PC (1440x900)", viewport: { width: 1440, height: 900 }, isMobile: false },
  { name: "iphone", label: "iPhone 14 (390x844)", device: devices["iPhone 14"], isMobile: true },
];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  [OK] ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}: ${detail ?? ""}`);
    console.log(`  [NG] ${name}  ${detail ?? ""}`);
  }
}

/** ページ全体で横スクロールが出ていないか。 */
async function horizontalOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

/**
 * 表示中の要素が親からはみ出していないか（＝文字切れ・重なりの目安）。
 * overflow を意図的に許している要素（表・コード塊）は除外する。
 */
async function overflowingElements(page) {
  return page.evaluate(() => {
    const allowed = ["PRE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH"];
    const out = [];
    const nodes = document.querySelectorAll(".view:not(.hidden) *");
    for (const node of nodes) {
      if (allowed.includes(node.tagName)) continue;
      if (node.closest(".table-scroll") || node.closest(".pre")) continue;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
      // 自分の内容が自分の箱からあふれているか
      if (node.scrollWidth > node.clientWidth + 2) {
        out.push({
          tag: node.tagName,
          cls: String(node.className).slice(0, 60),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          text: (node.textContent || "").trim().slice(0, 40),
        });
      }
    }
    return out.slice(0, 10);
  });
}

/** 触れる大きさか、かつ他の要素に覆われていないか。 */
async function checkInteractive(page, isMobile) {
  return page.evaluate((mobile) => {
    const result = { tooSmall: [], covered: [] };
    const nodes = document.querySelectorAll(".view:not(.hidden) button, .view:not(.hidden) input, .view:not(.hidden) textarea, .view:not(.hidden) select, .bottom-nav button, .sidebar button");
    for (const node of nodes) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const label = (node.textContent || node.getAttribute("aria-label") || node.id || node.tagName).trim().slice(0, 24);

      // ラジオ・チェックは小さくてよい（囲みの label が当たり判定になる）
      const isTiny = node.tagName === "INPUT" && ["radio", "checkbox", "file"].includes(node.type);
      if (!isTiny && r.height < 36) result.tooSmall.push({ label, height: Math.round(r.height) });

      // 画面内にある要素だけ、中心が自分（か子孫）かどうかを見る
      if (r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth) {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit !== node && !node.contains(hit) && !hit.contains(node)) {
          result.covered.push({ label, coveredBy: hit.tagName + "." + String(hit.className).slice(0, 30) });
        }
      }
    }
    return result;
  }, isMobile);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const profile of PROFILES) {
    console.log(`\n=== ${profile.label} ===`);
    const context = await browser.newContext(
      profile.device ? { ...profile.device } : { viewport: profile.viewport, deviceScaleFactor: 1 },
    );
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.goto(BASE, { waitUntil: "networkidle" });

    // メニューは 4 項目
    const navSelector = profile.isMobile ? ".bottom-nav button" : ".sidebar .nav-item";
    const navCount = await page.locator(navSelector).count();
    check(`${profile.name}: メニューが 4 項目`, navCount === 4, `実際 ${navCount} 件`);

    for (const view of VIEWS) {
      await page.locator(`${navSelector}[data-view="${view.key}"]`).click();
      await page.waitForTimeout(700);

      const visible = await page.locator(`#view-${view.key}`).isVisible();
      check(`${profile.name}/${view.label}: 画面が表示される`, visible);

      const ov = await horizontalOverflow(page);
      check(
        `${profile.name}/${view.label}: 横スクロールが出ない`,
        ov.scrollWidth <= ov.clientWidth + 1,
        `scrollWidth=${ov.scrollWidth} clientWidth=${ov.clientWidth}`,
      );

      const overflowing = await overflowingElements(page);
      check(
        `${profile.name}/${view.label}: 文字切れ・はみ出しがない`,
        overflowing.length === 0,
        JSON.stringify(overflowing),
      );

      const inter = await checkInteractive(page, profile.isMobile);
      check(
        `${profile.name}/${view.label}: 操作要素が十分な大きさ`,
        inter.tooSmall.length === 0,
        JSON.stringify(inter.tooSmall),
      );
      check(
        `${profile.name}/${view.label}: 操作要素が他に覆われていない`,
        inter.covered.length === 0,
        JSON.stringify(inter.covered),
      );

      // 最下部までスクロールしても、固定ナビが操作要素を覆わないこと
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      const bottomInter = await checkInteractive(page, profile.isMobile);
      check(
        `${profile.name}/${view.label}: 最下部でも操作要素が覆われない`,
        bottomInter.covered.length === 0,
        JSON.stringify(bottomInter.covered),
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);

      // 実際に見える範囲（固定ナビが正しい位置に写る）
      const file = path.join(OUT_DIR, `${profile.name}-${view.key}.png`);
      await page.screenshot({ path: file, fullPage: false });
      // 画面全体（長い内容の確認用。固定要素は先頭位置に写る）
      const fullFile = path.join(OUT_DIR, `${profile.name}-${view.key}-full.png`);
      await page.screenshot({ path: fullFile, fullPage: true });
      console.log(`       スクリーンショット: ${file} / ${fullFile}`);
    }

    // ホームの主要な文言
    await page.locator(`${navSelector}[data-view="home"]`).click();
    await page.waitForTimeout(500);
    const todoText = await page.locator("#todo-zone").innerText();
    check(
      `${profile.name}: TODO 0 件のとき所定の文言を出す`,
      /現在、ユーザー様の作業はありません|お願いしたいこと/.test(todoText),
      todoText.slice(0, 60),
    );

    check(`${profile.name}: JavaScript のエラーが出ていない`, consoleErrors.length === 0, consoleErrors.join(" / "));

    await context.close();
  }

  await browser.close();

  console.log(`\n合格 ${pass} / 不合格 ${fail}`);
  if (failures.length) {
    console.log("\n不合格の内訳:");
    for (const f of failures) console.log("  - " + f);
  }
  console.log(`スクリーンショット: ${OUT_DIR}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("画面確認に失敗しました:", err.message);
  process.exit(1);
});
