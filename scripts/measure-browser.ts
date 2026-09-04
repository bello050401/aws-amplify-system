/**
 * 実ブラウザからの性能計測（2026-09-04 最終フェーズ Phase A）。
 *
 *   AWS_PROFILE=Bello npm run measure:browser              … Warm のみ（既定）
 *   AWS_PROFILE=Bello npm run measure:browser -- --cold    … Cold も測る（10分待つ）
 *   AWS_PROFILE=Bello npm run measure:browser -- --runs=5  … 各条件の回数（既定3）
 *
 * ── なぜ必要か ──────────────────────────────────────────────────
 *
 * これまでの計測は DynamoDB / AppSync 区間だけだった。利用者が実際に
 * 感じるのは「クリックしてから操作できるまで」で、そこには
 * ネットワーク・SSR・JSの転送・hydration・React描画が全部乗る。
 * サーバーが速くてもブラウザが遅ければ意味がない。ここを実測する。
 *
 * ── 何を分解するか ──────────────────────────────────────────────
 *
 * Navigation Timing / Paint Timing から、1回の画面表示を次へ分解する。
 *
 *   TTFB         最初の1バイトが返るまで（＝ネットワーク往復 + SSR）
 *   HTML取得      レスポンス本文を受け取り終わるまで
 *   DOM構築       DOMContentLoaded まで（＝JSの解析・実行が始まるまで）
 *   初回描画      First Contentful Paint（＝何かが見えるまで）
 *   主要表示      その画面固有の目印が出るまで（＝欲しい情報が見えるまで）
 *   操作可能      主要な操作要素が有効になるまで
 *   総所要        goto から操作可能まで
 *
 * あわせて、その画面が出るまでのリクエスト数・種類・重複・直列/並列を
 * 記録する。「本来並列にできる通信が直列になっていないか」を見るため。
 *
 * ── Cold と Warm を混ぜない ─────────────────────────────────────
 *
 * Cold: まっさらなブラウザ（キャッシュ無し）＋ SSRがコールドの状態。
 *       SSRのウォーム保持は実測で「5分は保つ / 10分で落ちる」なので、
 *       --cold のときは11分空けてから測る。
 * Warm: 同じブラウザで2回目以降。
 *
 * 各条件を既定3回測り、**最小・中央値・最大**を出す。平均だけで見ない。
 *
 * ── 認証 ────────────────────────────────────────────────────────
 *
 * 保存済みのログイン状態（e2e/auth）があればそれを使い、保護された画面も
 * 測る。無ければ**公開画面だけ**を測り、その旨を明記する。
 * 認証を迂回したり、ゲートを緩めたりはしない。
 */
import { chromium, type BrowserContext, type Page, type Request } from "@playwright/test";
import { writeFileSync } from "node:fs";

const ORIGIN = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
/** SSRがコールドに落ちるまでの実測値は「5分は保つ / 10分で落ちる」。余裕を見て11分。 */
const COLD_IDLE_MINUTES = 11;

const args = process.argv.slice(2);
const WANT_COLD = args.includes("--cold");
const RUNS = Number(args.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? 3);
const OUT = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? null;

interface RouteDef {
  name: string;
  path: string;
  /** 主要な情報が見えたと判断する目印。 */
  contentSelector: string;
  /** 操作できると判断する要素（省略時は contentSelector と同じ）。 */
  interactiveSelector?: string;
  /** ログインが要るか。 */
  protected: boolean;
}

const ROUTES: RouteDef[] = [
  { name: "ログイン画面", path: "/inventory/login", contentSelector: 'input[type="password"]', protected: false },
  { name: "管理ログイン", path: "/admin/login", contentSelector: 'input[type="password"]', protected: false },
  { name: "在庫一覧", path: "/inventory", contentSelector: "table tbody tr, [data-testid='inventory-card']", interactiveSelector: 'input[name="q"]', protected: true },
  { name: "在庫一覧（検索）", path: "/inventory?q=%E3%82%BD%E3%83%95%E3%82%A1", contentSelector: "table tbody tr, [data-testid='inventory-card']", interactiveSelector: 'input[name="q"]', protected: true },
  { name: "メッセージ", path: "/inventory/messages", contentSelector: "main", protected: true },
  { name: "設定", path: "/inventory/settings", contentSelector: "main button", protected: true },
];

interface Sample {
  ttfbMs: number | null;
  htmlMs: number | null;
  domContentLoadedMs: number | null;
  fcpMs: number | null;
  contentMs: number | null;
  interactiveMs: number | null;
  totalMs: number;
  requests: number;
  apiRequests: number;
  duplicateRequests: number;
  transferKb: number;
  failed: string[];
}

function stat(values: number[]): { min: number; median: number; max: number } | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return {
    min: Math.round(v[0]),
    median: Math.round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2),
    max: Math.round(v[v.length - 1]),
  };
}

function fmt(s: { min: number; median: number; max: number } | null): string {
  return s ? `${s.median}ms (${s.min}〜${s.max})` : "—";
}

/** 1回ぶんの計測。 */
async function measureOnce(page: Page, route: RouteDef): Promise<Sample> {
  const requests: { url: string; startedAt: number }[] = [];
  const failed: string[] = [];
  let transfer = 0;

  const onRequest = (r: Request) => requests.push({ url: r.url(), startedAt: Date.now() });
  const onFailed = (r: Request) => failed.push(`${r.method()} ${r.url().slice(0, 90)}`);
  page.on("request", onRequest);
  page.on("requestfailed", onFailed);
  page.on("response", (res) => {
    const len = Number(res.headers()["content-length"] ?? 0);
    if (Number.isFinite(len)) transfer += len;
  });

  const started = Date.now();
  await page.goto(ORIGIN + route.path, { waitUntil: "domcontentloaded", timeout: 60_000 });

  let contentMs: number | null = null;
  try {
    await page.locator(route.contentSelector).first().waitFor({ state: "visible", timeout: 30_000 });
    contentMs = Date.now() - started;
  } catch {
    contentMs = null; // 出なかった。null のまま残す（0で埋めない）。
  }

  let interactiveMs: number | null = contentMs;
  const interactiveSelector = route.interactiveSelector;
  if (interactiveSelector) {
    try {
      const el = page.locator(interactiveSelector).first();
      await el.waitFor({ state: "visible", timeout: 30_000 });
      await el.isEnabled();
      interactiveMs = Date.now() - started;
    } catch {
      interactiveMs = null;
    }
  }
  const totalMs = Date.now() - started;

  // Navigation Timing / Paint Timing はブラウザ側の実測値をそのまま取る。
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0] as PerformanceEntry | undefined;
    return {
      ttfb: nav ? nav.responseStart - nav.startTime : null,
      html: nav ? nav.responseEnd - nav.startTime : null,
      dcl: nav ? nav.domContentLoadedEventEnd - nav.startTime : null,
      fcp: fcp ? fcp.startTime : null,
    };
  });

  page.off("request", onRequest);
  page.off("requestfailed", onFailed);

  const urls = requests.map((r) => r.url);
  const seen = new Map<string, number>();
  for (const u of urls) seen.set(u, (seen.get(u) ?? 0) + 1);
  const duplicateRequests = [...seen.values()].filter((n) => n > 1).length;

  return {
    ttfbMs: timing.ttfb,
    htmlMs: timing.html,
    domContentLoadedMs: timing.dcl,
    fcpMs: timing.fcp,
    contentMs,
    interactiveMs,
    totalMs,
    requests: requests.length,
    // AppSync / Server Action / API ルートへの通信。
    apiRequests: urls.filter((u) => /appsync|\/api\/|\/_next\/data\//.test(u)).length,
    duplicateRequests,
    transferKb: Math.round(transfer / 1024),
    failed,
  };
}

interface RouteResult {
  route: RouteDef;
  condition: "Cold" | "Warm";
  samples: Sample[];
}

async function measureRoute(context: BrowserContext, route: RouteDef, condition: "Cold" | "Warm", runs: number): Promise<RouteResult> {
  const samples: Sample[] = [];
  const page = await context.newPage();
  try {
    for (let i = 0; i < runs; i++) {
      samples.push(await measureOnce(page, route));
    }
  } finally {
    await page.close();
  }
  return { route, condition, samples };
}

function renderTable(results: RouteResult[]): string {
  const lines: string[] = [];
  lines.push("| 画面 | 条件 | TTFB | HTML取得 | DOM構築 | 初回描画 | 主要表示 | 操作可能 | 総所要 | 通信数 | API数 | 転送 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const pick = (f: (s: Sample) => number | null) => stat(r.samples.map(f).filter((n): n is number => n !== null));
    lines.push(
      `| ${r.route.name} | ${r.condition} | ${fmt(pick((s) => s.ttfbMs))} | ${fmt(pick((s) => s.htmlMs))} | ` +
        `${fmt(pick((s) => s.domContentLoadedMs))} | ${fmt(pick((s) => s.fcpMs))} | ${fmt(pick((s) => s.contentMs))} | ` +
        `${fmt(pick((s) => s.interactiveMs))} | ${fmt(pick((s) => s.totalMs))} | ` +
        `${Math.round(r.samples.reduce((a, s) => a + s.requests, 0) / r.samples.length)} | ` +
        `${Math.round(r.samples.reduce((a, s) => a + s.apiRequests, 0) / r.samples.length)} | ` +
        `${Math.round(r.samples.reduce((a, s) => a + s.transferKb, 0) / r.samples.length)}KB |`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const { hasSavedState, STAGING_STATE_FILE } = await import("../e2e/auth/stagingAuth");
  const authenticated = hasSavedState();
  const routes = ROUTES.filter((r) => authenticated || !r.protected);

  console.log(`[measure-browser] ${ORIGIN}`);
  console.log(`  条件: ${WANT_COLD ? "Cold + Warm" : "Warm のみ"} / 各${RUNS}回`);
  if (!authenticated) {
    console.log("");
    console.log("  ⚠ ログイン状態が保存されていないため、**公開画面だけ**を測ります。");
    console.log("    保護された画面（在庫一覧・メッセージ・設定）を測るには、");
    console.log("    次を1回だけ実行してログイン情報を登録してください:");
    console.log("      powershell -NoProfile -ExecutionPolicy Bypass -File .\\tools\\staging-auth\\Set-BelloStagingCredential.ps1");
    console.log("    （認証の迂回やゲートの無効化はしません）");
    console.log("");
  }

  const results: RouteResult[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    if (WANT_COLD) {
      console.log(`\n■ Cold（SSRを冷やすため ${COLD_IDLE_MINUTES} 分待ちます）`);
      await new Promise((r) => setTimeout(r, COLD_IDLE_MINUTES * 60_000));
      for (const route of routes) {
        // まっさらな context = ブラウザキャッシュも空。
        const ctx = await browser.newContext(authenticated ? { storageState: STAGING_STATE_FILE } : {});
        const res = await measureRoute(ctx, route, "Cold", 1); // Coldは定義上1回だけ
        await ctx.close();
        results.push(res);
        console.log(`  ${route.name}: 総所要 ${res.samples[0].totalMs}ms / TTFB ${Math.round(res.samples[0].ttfbMs ?? 0)}ms`);
      }
    }

    console.log("\n■ Warm");
    const ctx = await browser.newContext(authenticated ? { storageState: STAGING_STATE_FILE } : {});
    for (const route of routes) {
      const res = await measureRoute(ctx, route, "Warm", RUNS);
      results.push(res);
      const t = stat(res.samples.map((s) => s.totalMs));
      console.log(`  ${route.name}: 総所要 ${fmt(t)} / 通信${Math.round(res.samples[0].requests)}本`);
      const failures = res.samples.flatMap((s) => s.failed);
      if (failures.length > 0) console.log(`    失敗したリクエスト: ${[...new Set(failures)].slice(0, 3).join(" / ")}`);
    }
    await ctx.close();
  } finally {
    await browser.close();
  }

  const table = renderTable(results);
  console.log("\n" + table);
  if (OUT) {
    writeFileSync(OUT, `# 実ブラウザ計測 (${new Date().toISOString()})\n\n認証: ${authenticated ? "あり" : "なし（公開画面のみ）"}\n\n${table}\n`, "utf8");
    console.log(`\n${OUT} に保存しました。`);
  }
}

void main().catch((err) => {
  console.error(`[measure-browser] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
