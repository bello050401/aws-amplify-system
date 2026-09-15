import "server-only";
import { cookies } from "next/headers";
import { isE2EFixtureModeActive } from "./e2eFixtures";
import { shiftYearMonth } from "./sales";
import type { SalesSummaryView, SalesTrendPoint } from "./salesView";
import type { SalesTotals } from "./salesAggregate";

/**
 * 売上予測候補b2b385f(異常日時と表示整合、2026-09-15)の実ブラウザQA。
 *
 * ── なぜ実集計テーブルを使えないか ─────────────────────────────────
 *
 * このsandbox環境には実AWS(AppSync)への到達経路が無く
 * (lib/inventory/e2eFixtures.tsの冒頭コメント参照)、SalesAggregateSnapshot
 * への実GetItemは常に失敗する。加えて、たとえ実テーブルに到達できても
 * 「前日21時snapshotを翌朝に見る」「rebuiltAtが不正/未来」という異常系を
 * 実データで再現するには本番集計テーブルへの直接書き込みが要る——実DB・
 * 実集計ロジックには一切触れない、というこのタスクの制約(6. 変更しては
 * いけない範囲)と両立しない。
 *
 * ここではlib/inventory/salesView.tsのloadSalesSummaryが返す
 * SalesSummaryViewをまるごと合成で置き換える——集計テーブルへの
 * GetItemそのものが発生しないため、実SDK到達は構造的にゼロになる
 * (scripts/verify-sales-summary-e2e-isolation.tsで実証)。
 *
 * ── 二重ゲート ──────────────────────────────────────────────────
 *
 * 新しいフラグを追加しない。`lib/inventory/e2eFixtures.ts`の
 * `isE2EFixtureModeActive()`(NODE_ENV!=="production" かつ
 * INVENTORY_E2E_FIXTURES==="1")をそのまま再利用する——本番でこの
 * ファイルの分岐が通る経路は無い(呼び出し元のsalesView.tsが毎回
 * このゲートを先に確認してから初めてこのモジュールの関数を呼ぶ)。
 * 書き込み系分岐は無い(このページ自体が読み取り専用)。
 *
 * ── シナリオ切替(Cookie) ────────────────────────────────────────
 *
 * `lib/inventory/zaicoSyncE2eFixtures.ts`の`__inv_e2e_zaico_scenario`と
 * 同じ発想で、読み取り専用のCookie(`__inv_e2e_sales_scenario`)を
 * Playwright側が事前に積んでおくことで、同じ1devサーバーのまま
 * 「正常(前日snapshot)」「不正な集計日時」「未来の集計日時」を行き来する。
 * このCookie自体はゲートではない——isE2EFixtureModeActive()がfalseなら
 * このファイルの関数はそもそも呼ばれない。
 *
 * 対象年月は固定でCURRENT_YEAR/CURRENT_MONTHのみ——シナリオの効果は
 * 「表示対象の年月がJSTで見た現在進行中の月」のときにしか意味を持たない
 * (forecastReferenceDay/page.tsxのisCurrentJstYearMonth判定)ため、
 * これ以外の年月をリクエストされたとき(前月/翌月リンク、過去月QA)は
 * シナリオに関係なく常に「正常」な合成データを返す——「過去月は着地予測
 * なし」がシナリオの異常表示と混同されないようにするため。
 *
 * ── 固定時刻 ─────────────────────────────────────────────────────
 *
 * page.tsx自体の「今」の判定(new Date())は差し替えない——サーバーの
 * 実行時刻をこのフィクスチャから制御する経路は無い。その代わり、集計
 * 日時(aggregateRebuiltAt)側をこの合成モジュールが実行される時点の
 * JSTでの「前日」を起点に組み立てる(下記yesterdayJstIso参照)ことで、
 * 実行日がいつであっても「前日21時に再構築されたsnapshotを翌朝に見る」
 * という不具合の再現条件(scripts/verify-sales-forecast-snapshot-
 * alignment.tsのシナリオ1と同じ形)を安定して満たす——月初(1日)に実行
 * された場合は前日が前月に繰り上がり、forecastReferenceDayが
 * different-monthとしてok:falseを返す(=着地予測が出ない)ことになるが、
 * これ自体も定義済みの異常系の1つであり、実行に失敗するわけではない
 * (Codexが実際に確認する際は月初を避けて実行することを完了報告に明記)。
 */
export type SalesE2EScenario = "normal" | "invalid" | "future";

const SCENARIO_COOKIE = "__inv_e2e_sales_scenario";

function resolveScenario(): SalesE2EScenario {
  const raw = cookies().get(SCENARIO_COOKIE)?.value;
  return raw === "invalid" || raw === "future" ? raw : "normal";
}

/** シナリオ表示対象の月(このモジュールが呼ばれた時点のJSTでの現在月)。 */
function currentJstYearMonth(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  const get = (type: "year" | "month") => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month") };
}

/** 実行時点のJSTでの「前日21:00」をISO(UTC)文字列で返す(正常シナリオ用)。 */
function yesterdayJst21IsoRelativeTo(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (type: "year" | "month" | "day") => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Date.UTCは月/日の範囲外(0や32等)を自動的に繰り上げ/繰り下げ正規化する
  // ため、月初(day=1)でも前月末日へ正しくロールバックする。
  // 21:00 JST = 12:00 UTC(同日)。
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day") - 1, 12, 0)).toISOString();
}

/** シナリオ別のrebuiltAt(集計日時)。現在月を表示しているときだけ効く。 */
function currentMonthRebuiltAt(scenario: SalesE2EScenario, now: Date): string {
  switch (scenario) {
    case "invalid":
      // Dateとして解析できない不正な文字列——forecastReferenceDayが
      // reason:"invalid"でok:falseを返す想定。
      return "e2e-fixture-invalid-timestamp";
    case "future":
      // 閲覧時刻よりも確実に未来(クロックスキュー等の異常系)。
      return "2099-01-01T00:00:00.000Z";
    case "normal":
    default:
      return yesterdayJst21IsoRelativeTo(now);
  }
}

/** 現在月の売上高本体(シナリオに関係なく一定——「予測の有無」と「売上本体」を分離して確認できるようにするため)。 */
const CURRENT_MONTH_TOTALS_BASE = {
  count: 48,
  totalSales: 2_407_020,
  totalPurchase: 1_100_000,
  totalShipping: 36_000,
  totalCost: 1_203_510,
  totalProfit: 2_407_020 - 1_203_510,
};

function currentMonthTotals(year: number, month: number): SalesTotals {
  const totalSales = CURRENT_MONTH_TOTALS_BASE.totalSales;
  const totalCost = CURRENT_MONTH_TOTALS_BASE.totalCost;
  return {
    year,
    month,
    count: CURRENT_MONTH_TOTALS_BASE.count,
    totalSales,
    totalPurchase: CURRENT_MONTH_TOTALS_BASE.totalPurchase,
    totalShipping: CURRENT_MONTH_TOTALS_BASE.totalShipping,
    totalCost,
    costRate: totalSales === 0 ? 0 : (totalCost / totalSales) * 100,
    totalProfit: CURRENT_MONTH_TOTALS_BASE.totalProfit,
    averageSalePrice: Math.round(totalSales / CURRENT_MONTH_TOTALS_BASE.count),
  };
}

/** 現在月以外(前月/翌月・過去月QA用)の決定論的な合成値。実行時刻に依存しない。 */
function baselineTotals(year: number, month: number): SalesTotals {
  const seed = year * 12 + month;
  const totalSales = 800_000 + (seed % 17) * 53_000;
  const totalCost = Math.round(totalSales * 0.52);
  const totalShipping = Math.round(totalSales * 0.015);
  const count = 10 + (seed % 9);
  return {
    year,
    month,
    count,
    totalSales,
    totalPurchase: totalCost - totalShipping,
    totalShipping,
    totalCost,
    costRate: totalSales === 0 ? 0 : (totalCost / totalSales) * 100,
    totalProfit: totalSales - totalCost,
    averageSalePrice: Math.round(totalSales / count),
  };
}

/** baselineTotalsの月にも、月内に収まる無難なrebuiltAt(28日09:00 JST)を持たせる。 */
function baselineRebuiltAt(year: number, month: number): string {
  // 09:00 JST = 00:00 UTC(同日)。
  return new Date(Date.UTC(year, month - 1, 28, 0, 0)).toISOString();
}

/**
 * `lib/inventory/salesView.ts`のloadSalesSummaryがisE2EFixtureModeActive()
 * 通過後にだけ呼ぶ。実集計テーブルへは一切アクセスしない。
 */
export function e2eLoadSalesSummary(year: number, month: number): SalesSummaryView {
  const now = new Date();
  const { year: curYear, month: curMonth } = currentJstYearMonth();

  const months: { year: number; month: number }[] = [];
  for (let i = 11; i >= 0; i--) months.push(shiftYearMonth(year, month, -i));

  const trend: SalesTrendPoint[] = months.map((m) => {
    const totals = m.year === curYear && m.month === curMonth ? currentMonthTotals(m.year, m.month) : baselineTotals(m.year, m.month);
    return { year: m.year, month: m.month, status: "ok", totalSales: totals.totalSales, totalGrossProfit: totals.totalProfit };
  });

  if (year === curYear && month === curMonth) {
    const scenario = resolveScenario();
    return {
      year,
      month,
      status: "ok",
      totals: currentMonthTotals(year, month),
      aggregateRebuiltAt: currentMonthRebuiltAt(scenario, now),
      trend,
    };
  }

  return {
    year,
    month,
    status: "ok",
    totals: baselineTotals(year, month),
    aggregateRebuiltAt: baselineRebuiltAt(year, month),
    trend,
  };
}

/** salesView.ts側のガードが同じ判定を再実装しないための再エクスポート。 */
export { isE2EFixtureModeActive as isSalesE2EFixtureModeActive };
