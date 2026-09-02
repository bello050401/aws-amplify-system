import type { ConsoleMessage, Page } from "@playwright/test";

/**
 * Staging 実機テストの共通ヘルパー。
 *
 * ここは**実データを見に行く**テストなので、書き込みを伴う操作は
 * 既定では行わない。行うものは各specで明示的にopt-inさせる。
 */

/** 計測1回ぶん。 */
export interface RouteTiming {
  path: string;
  /** goto が返るまで(サーバー応答 + DOMContentLoaded)。 */
  domContentLoadedMs: number;
  /** 画面が実用になるまで(そのルート固有の目印が出るまで)。 */
  usableMs: number;
  /** Navigation Timing API の TTFB。 */
  ttfbMs: number | null;
  /** 画面遷移中に出た console のエラー。 */
  consoleErrors: string[];
  /** 画面遷移中に失敗したリクエスト。 */
  failedRequests: string[];
}

/**
 * console のエラーと失敗リクエストを、そのページが閉じるまで集める。
 *
 * hydration の警告は console.error として出るので、これを拾うと
 * 「console error 0」の確認がそのままできる。
 */
export function collectPageProblems(page: Page): { consoleErrors: string[]; failedRequests: string[] } {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // ブラウザ拡張・広告ブロッカー由来のノイズは対象外。Stagingは
    // 素のchromiumで開くので通常は出ないが、出ても実装の問題ではない。
    if (text.includes("chrome-extension://")) return;
    consoleErrors.push(text);
  });

  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "unknown";
    // ページ遷移で中断されたリクエストは失敗ではない。
    if (failure.includes("ERR_ABORTED")) return;
    failedRequests.push(`${req.method()} ${req.url()} — ${failure}`);
  });

  page.on("response", (res) => {
    if (res.status() >= 500) failedRequests.push(`HTTP ${res.status()} ${res.url()}`);
  });

  return { consoleErrors, failedRequests };
}

/**
 * 1ルートを開いて、実用になるまでの時間を測る。
 *
 * 「usable」の定義をルートごとに渡してもらう —— 「DOMが来た」では
 * 実用性を測れない(在庫一覧は表が描画されて初めて使える)。
 */
export async function measureRoute(
  page: Page,
  path: string,
  usable: (page: Page) => Promise<void>,
): Promise<RouteTiming> {
  const problems = collectPageProblems(page);

  const started = Date.now();
  await page.goto(path, { waitUntil: "domcontentloaded" });
  const domContentLoadedMs = Date.now() - started;

  await usable(page);
  const usableMs = Date.now() - started;

  const ttfbMs = await page
    .evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return nav ? Math.round(nav.responseStart - nav.requestStart) : null;
    })
    .catch(() => null);

  return {
    path,
    domContentLoadedMs,
    usableMs,
    ttfbMs,
    consoleErrors: [...problems.consoleErrors],
    failedRequests: [...problems.failedRequests],
  };
}

/** 表形式で計測結果を出す(報告へそのまま貼れる形)。 */
export function formatTimings(rows: RouteTiming[]): string {
  const head = `${"route".padEnd(34)} ${"DOM".padStart(8)} ${"usable".padStart(8)} ${"TTFB".padStart(7)}  console`;
  const body = rows.map(
    (r) =>
      `${r.path.padEnd(34)} ${`${r.domContentLoadedMs}ms`.padStart(8)} ${`${r.usableMs}ms`.padStart(8)} ` +
      `${(r.ttfbMs != null ? `${r.ttfbMs}ms` : "—").padStart(7)}  ${r.consoleErrors.length}`,
  );
  return [head, "-".repeat(head.length), ...body].join("\n");
}

/**
 * 在庫IDを1件だけ拾う(実データ依存のテストで使う)。
 * 一覧の先頭行のリンク先から取る。
 */
export async function firstInventoryId(page: Page): Promise<string | null> {
  await page.goto("/inventory", { waitUntil: "domcontentloaded" });
  const link = page.locator('a[href^="/inventory/"]').first();
  if ((await link.count()) === 0) return null;
  const href = await link.getAttribute("href");
  const m = href ? /^\/inventory\/([0-9a-f-]{36})/.exec(href) : null;
  return m ? m[1] : null;
}
