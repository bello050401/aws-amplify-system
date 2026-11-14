/**
 * app/inventory/(protected)/sales/SalesTrendChart.tsx の静的SSRレンダリング検証。
 *
 * ── なぜこれが要る ──────────────────────────────────────────────
 * 前回審査で「npm run dev + ブラウザで missing/error/実0件 の3状態が
 * 画面上で描き分けられていることを目視確認せよ」という指摘を受けたが、
 * このセッションは承認サーフェスが無く(dev-orchestratorのworktree実行
 * セッション)、`npm run dev`(バックグラウンド常駐プロセス)もブラウザ
 * 操作(スクリーンショット)も自動承認されず拒否される
 * (evidence/06-npm-run-dev-rejected.txt参照、次セッションでの目視確認
 * が必須)。
 *
 * その代替として、実際にブラウザ/Next.jsが描画するのと同じ
 * SalesTrendChart.tsx(本物のコンポーネント、再実装や模倣ではない)を
 * react-dom/server の renderToStaticMarkup で実際にSSRし、出力された
 * SVG/HTML文字列を検証する——「3状態が描き分けられている」という主張を
 * 実際のレンダリング結果に対する実測で裏付ける。目視確認そのものの
 * 代わりにはならないが、コンポーネントのロジックが本当に3状態を別の
 * 見た目(色・aria-label・折れ線の途切れ)として出力していることは、
 * ブラウザを使わずここで実測できる。
 *
 * 実行: node scripts/with-server-only-stub.cjs scripts/verify-sales-trend-chart-render.tsx
 * (SalesTrendChart.tsxはserver-onlyに依存しないが、他のverify scriptと
 * 起動方法を揃えるため同じランナーを使う)
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }): void;
}

const projectRoot = pathToFileURL(process.cwd() + "/").href;

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    const target = specifier.startsWith("@/") ? projectRoot + specifier.slice(2) : specifier;
    try {
      return nextResolve(target, context);
    } catch {
      return nextResolve(target + ".ts", context);
    }
  },
});

let passes = 0;
let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // tsx(esbuild)はこのプロジェクトのtsconfig("jsx": "preserve",
  // Next.js/SWCの自動ランタイム前提)をそのままでは解釈できず、
  // classic runtime(React.createElementへの変換 + Reactがグローバル
  // スコープに要る想定)にフォールバックする——Next.js本体のビルド
  // (npm run build、実SWC)ではこの問題は起きない(evidence/
  // 01-npm-run-build.txtで実証済み)。ここはSSR描画結果を検証する
  // ためだけの補助であり、コンポーネント側のコードは一切変更しない。
  (globalThis as unknown as { React: typeof React }).React = React;
  const { SalesTrendChart } = await import("../app/inventory/(protected)/sales/SalesTrendChart");
  type Point = {
    year: number;
    month: number;
    status: "ok" | "missing" | "error";
    totalSales: number;
    totalGrossProfit: number;
  };

  // 実0件(ok・totalSales=0)/missing(未集計)/error(取得エラー)/通常okを
  // 1本の推移に混在させる——SalesTrendChart.tsxが実際に受け取る形。
  const points: Point[] = [
    { year: 2026, month: 4, status: "ok", totalSales: 100000, totalGrossProfit: 40000 },
    { year: 2026, month: 5, status: "missing", totalSales: 0, totalGrossProfit: 0 },
    { year: 2026, month: 6, status: "error", totalSales: 0, totalGrossProfit: 0 },
    { year: 2026, month: 7, status: "ok", totalSales: 0, totalGrossProfit: 0 }, // 実0件(集計は確定しているが売上0円)
    { year: 2026, month: 8, status: "ok", totalSales: 50000, totalGrossProfit: 20000 },
    { year: 2026, month: 9, status: "ok", totalSales: 60000, totalGrossProfit: 25000 },
  ];

  const html = renderToStaticMarkup(React.createElement(SalesTrendChart, { points }));

  console.log("── シナリオ: 6ヶ月分(ok/missing/error/実0件混在)をSSR ──");

  // missing月のaria-label/titleに「未集計」が出て、totalSales/totalGrossProfitではない
  check(html.includes("2026年5月: 未集計"), "★要件: missing月のaria-labelに「未集計」が出る(0円実績と文言で区別)");
  check(!/2026年5月: 売上高/.test(html), "★要件: missing月に売上高の数値文言が出ない");

  // error月のaria-label/titleに「取得エラー」が出る
  check(html.includes("2026年6月: 取得エラー"), "★要件: error月のaria-labelに「取得エラー」が出る");
  check(!/2026年6月: 売上高/.test(html), "★要件: error月に売上高の数値文言が出ない");

  // 実0件(ok・0円)は「売上高 ¥0」という実測値の文言が出る(missing/errorの文言とは別物)
  check(html.includes("2026年7月: 売上高 ¥0"), "★要件: 実0件(ok・0円)は「売上高 ¥0」という実測の0円として出る(未集計/エラーの文言とは別)");

  // missingとerrorでリングの色(stroke)が違う — missing=灰(#9ca3af)、error=赤(#dc2626)
  const errorRingCount = (html.match(/stroke="#dc2626"/g) || []).length;
  const missingRingCount = (html.match(/stroke="#9ca3af"/g) || []).length;
  check(errorRingCount >= 1, "★要件: error月は赤いリング(#dc2626)で描画される", `${errorRingCount}箇所`);
  check(missingRingCount >= 1, "★要件: missing月は灰色のリング(#9ca3af)で描画される", `${missingRingCount}箇所`);

  // ok(実0件含む)の点は塗りつぶし円(fill="#111827"などの実測プロット) — missing/errorは白抜き(fill="white")
  const filledOkCircles = (html.match(/fill="#111827"/g) || []).length; // 売上高の点
  check(filledOkCircles >= 4, "★要件: ok(実0件含む)の月は塗りつぶし円で売上高がプロットされる", `${filledOkCircles}箇所`);
  const hollowCircles = (html.match(/fill="white" stroke=/g) || []).length;
  check(hollowCircles === 2, "★要件: missing/errorの月(2ヶ月)だけが白抜きリングになる(okの月は白抜きにならない)", `${hollowCircles}箇所`);

  // 折れ線(売上高パス)はmissing/errorの月をまたいで直接つながず、セグメントが分断される
  // (4月ok→5月missing→6月error→7月ok なので、売上高パスは "M"(新規開始)が
  //  少なくとも2回現れる=1本の連続線にならず途切れる)
  const salesPathMatch = html.match(/<path d="([^"]*)" fill="none" stroke="#111827"/);
  const salesPathSegmentStarts = salesPathMatch ? (salesPathMatch[1].match(/M /g) || []).length : 0;
  check(
    salesPathSegmentStarts >= 2,
    "★要件: missing/errorの月を挟むと折れ線が0円へ繋がらず別セグメントとして途切れる",
    `M(新規開始)が${salesPathSegmentStarts}回`,
  );

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
