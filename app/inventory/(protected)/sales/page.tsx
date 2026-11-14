import Link from "next/link";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { loadSalesSummary } from "@/lib/inventory/salesView";
import {
  nowInJst,
  isCurrentJstYearMonth,
  calculateMonthEndForecast,
  forecastReferenceDay,
  shiftYearMonth,
  formatJstDateTime,
} from "@/lib/inventory/sales";
import { InventoryHeader } from "../../InventoryHeader";
import { YearMonthPicker } from "./YearMonthPicker";
import { jstDay } from "@/lib/inventory/analysisUi/model";
import { SalesTrendChart } from "./SalesTrendChart";
import { SalesItemsSection } from "./SalesItemsSection";
import {InventoryValuePicker} from './InventoryValuePanel';
import {SalesAnalysisTabs} from './analysis/SalesAnalysis';
import {ProductionSalesAnalysis} from './analysis/ProductionSalesAnalysis';
import './analysis/analysis.css';
import {loadInventoryValue} from '@/lib/inventory/inventoryValueStore';

interface SalesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SalesPage(props: SalesPageProps) {
  const raw = await props.searchParams;
  const searchParams = Object.fromEntries(Object.entries(raw).filter((entry):entry is [string,string]=>typeof entry[1] === "string"));
  const role = await getInventoryRole();
  if (!role) return null;
  const now = new Date();
  const today = jstDay(now);
  const canManage = role === "ADMIN";
  if (searchParams.view === 'breakdown') {
    return <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold">売上</h1>}/>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <SalesAnalysisTabs today={today}/>
        <ProductionSalesAnalysis today={today} canManage={canManage}/>
      </div>
    </div>;
  }
  if (searchParams.view === 'inventory') {
    const inventory = await loadInventoryValue(searchParams.month || undefined);
    return <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold">売上</h1>}/>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <SalesAnalysisTabs today={today}/>
        <div className="space-y-5">
          <InventoryValuePicker key={searchParams.month} month={searchParams.month} query={searchParams}/>
          <ProductionSalesAnalysis today={today} canManage={canManage} inventory={inventory}/>
        </div>
      </div>
    </div>;
  }

  // 追加修正指示 §5: 「今日」「今月」の判定はすべてJST(Asia/Tokyo)基準
  // で行う — サーバーの実行タイムゾーン(AWS/Amplify Hostingは通常UTC)
  // にnew Date()の年/月/日をそのまま使うと、日本時間の夜間~早朝
  // (UTCでは日付が進む/戻る境界)に「今月」の判定や着地予測が実際とズレ
  // うる。lib/inventory/sales.tsのnowInJstがこのズレを吸収する。
  // 2026-09-15 異常系表示修正: ページ内の「今」の判定(今月かどうか/
  // 集計日時が閲覧時刻より未来でないか)はすべてこの1つのDateインスタンス
  // を基準にする——isCurrentJstYearMonthとforecastReferenceDayが別々に
  // new Date()を呼ぶと、理論上はミリ秒単位でズレた「今」を基準に判定して
  // しまう(実害はほぼ無いが、根拠を1点に揃えるという方針そのものに反する)。
  const jstNow = nowInJst(now);
  // 月と同じように年も検証する。以前は年だけ素通りで、URLを直接
  // 書き換えると「-5年8月」「99999年1月」「10000000000年3月」といった
  // 見出しがそのまま出ていた(実測)。前月/翌月リンクもその値を基準に
  // 作られるため、一度入ると抜け出しにくい。BELLOの創業より前や
  // 翌年より先の売上は存在しないので、その範囲外は今月へ戻す。
  const yearRaw = Number(searchParams.y);
  const year = Number.isInteger(yearRaw) && yearRaw >= 2000 && yearRaw <= jstNow.year + 1 ? yearRaw : jstNow.year;
  const monthRaw = Number(searchParams.m) || jstNow.month;
  const month = Number.isInteger(monthRaw) && monthRaw >= 1 && monthRaw <= 12 ? monthRaw : jstNow.month;

  const view = await loadSalesSummary(year, month);
  const summary = view.totals;

  function monthHref(y: number, m: number): string {
    return `/inventory/sales?y=${y}&m=${m}`;
  }

  const prev = shiftYearMonth(year, month, -1);
  const next = shiftYearMonth(year, month, 1);
  const thisMonth = { year: jstNow.year, month: jstNow.month };
  const lastMonth = shiftYearMonth(thisMonth.year, thisMonth.month, -1);
  const isCurrent = isCurrentJstYearMonth(year, month, now);

  // 追加修正指示 §3-§8 + 2026-09-15 異常系表示修正: 今月の売上着地予測。
  // 当月が"ok"(集計テーブルから実際の値が取れている)のときにのみ計算
  // する——"missing"/"error"の状態から0円ベースで予測を計算すると、
  // 実際にはまだ集計されていないだけの月を「着地予測ゼロ」のように見せ
  // てしまうため。
  //
  // 分母(経過日数)にはjstNow.day(画面を開いた時点の「今日」)をそのまま
  // 使わない——SalesAggregateSnapshotは12時間おきにしか再構築されない
  // ため、再構築時刻と閲覧時刻がずれると、totalSalesが実際に反映して
  // いる日数と分母が食い違う(例: 前日21時に再構築された集計を翌朝見る
  // と、売上が1円も増えていないのに日付が変わっただけで着地予測が下が
  // って見える)。forecastReferenceDay(lib/inventory/sales.ts)が
  // view.aggregateRebuiltAtのJST日を分母として使い、totalSalesとの時点
  // を揃える。
  //
  // rebuiltAtが不正な文字列/表示対象と別月/閲覧時刻より未来—のいずれか
  // (forecastReferenceDayがok:falseを返す異常系)では、根拠が不明な数字
  // を出すよりは「予測なし」にする——売上高本体(summary.totalSales)の
  // 表示はforecastの有無に関係なく維持される(下のSummaryTile参照)。
  const referenceDay =
    isCurrent && view.status === "ok" && view.aggregateRebuiltAt
      ? forecastReferenceDay(view.aggregateRebuiltAt, year, month, now)
      : null;
  const forecast = referenceDay?.ok ? calculateMonthEndForecast(summary.totalSales, year, month, referenceDay.day) : null;
  // 異常系のときだけ「算出不可」の簡潔な理由を出す(過去月/missing/error
  // では着地予測欄自体を出さない——既存どおり)。
  const forecastUnavailable = referenceDay !== null && !referenceDay.ok ? referenceDay.reason : null;

  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">売上</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <SalesAnalysisTabs today={today}/>
        {/* 集計をいつ作り直したか、そもそも集計が無い/読めないのかを
            隠さずに出す —— §8「初期未集計と実0件を区別」の要件その
            もの。0円と「まだ集計されていない」を絶対に混同させない。
            2026-09-11 世代整合性修正 §4: 表示はJSTへ変換する
            (formatJstDateTime)——以前のUTC文字列切り出しは廃止した。 */}
        {view.status === "ok" && view.aggregateRebuiltAt && (
          <p className="mb-2 text-[11px] text-gray-400">
            集計は {formatJstDateTime(view.aggregateRebuiltAt)} JST 時点のものです。
          </p>
        )}
        {view.status === "missing" && (
          <p className="mb-2 text-[11px] font-bold text-amber-600">
            {year}年{month}月の集計はまだ作られていません(未集計) — 実売上が0円という意味ではありません。
          </p>
        )}
        {view.status === "error" && (
          <p className="mb-2 text-[11px] font-bold text-red-600">
            {year}年{month}月の集計を取得できませんでした(取得エラー) — 実売上が0円という意味ではありません。
          </p>
        )}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Link href={monthHref(prev.year, prev.month)} className="border border-gray-300 px-2 py-1 text-[12px] text-gray-600 hover:bg-gray-50">
            ← 前月
          </Link>
          <YearMonthPicker year={view.year} month={view.month} currentYear={jstNow.year} />
          <Link href={monthHref(next.year, next.month)} className="border border-gray-300 px-2 py-1 text-[12px] text-gray-600 hover:bg-gray-50">
            翌月 →
          </Link>
          <span className="mx-1 h-4 w-px bg-gray-200" aria-hidden />
          <Link
            href={monthHref(thisMonth.year, thisMonth.month)}
            className={`border px-2 py-1 text-[12px] ${isCurrent ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
          >
            今月
          </Link>
          <Link href={monthHref(lastMonth.year, lastMonth.month)} className="border border-gray-300 px-2 py-1 text-[12px] text-gray-600 hover:bg-gray-50">
            先月
          </Link>
        </div>

        {/* 追加修正指示 §3-§8: 今月の売上着地予測。当月進行中(isCurrent)
            かつ集計が"ok"のときだけ表示する。 */}
        {forecast && (
          <div className="mb-6 max-w-3xl">
            <p className="mb-1.5 text-[11px] font-bold text-gray-400">今月の売上着地予測</p>
            <div className="grid grid-cols-1 gap-px border border-gray-200 bg-gray-200 sm:grid-cols-2">
              <SummaryTile label="1日平均売上" value={`${yen(Math.round(forecast.averageDailySales))} / 日`} />
              <SummaryTile label="今月の売上着地予測" value={yen(Math.round(forecast.projectedMonthEndSales))} />
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              {forecast.month}月{forecast.today}日時点 / {forecast.totalDaysInMonth}日間
            </p>
          </div>
        )}
        {/* 2026-09-15 異常系表示修正: 集計日時が不正/表示対象と別月/
            閲覧時刻より未来——のいずれかで着地予測の根拠が揃わない場合、
            数字を出さず理由だけ簡潔に示す。売上高本体は下のSummaryTileで
            引き続き表示される(§8「0円と未集計を混同させない」と同じ
            考え方で、予測の有無と実績の表示を分離する)。 */}
        {forecastUnavailable && (
          <div className="mb-6 max-w-3xl">
            <p className="mb-1.5 text-[11px] font-bold text-gray-400">今月の売上着地予測</p>
            <p className="text-[12px] text-gray-500">
              集計日時を確認できないため、着地予測は算出できません(実績の売上高には影響ありません)。
            </p>
          </div>
        )}

        {/* 集計サマリー。status !== "ok" のときは実数ではなく"—"を出す
            (0円と未集計/エラーを混同させない、§8)。
            BELLO統合改修 master指示書(2026-08-29統合改修版) Q15/§19:
            「利益」ではなく必ず「粗利益」と表示する。 */}
        <div className="mb-6 grid max-w-3xl grid-cols-2 gap-px border border-gray-200 bg-gray-200 sm:grid-cols-3">
          <SummaryTile label="売上高" value={view.status === "ok" ? yen(summary.totalSales) : "—"} />
          <SummaryTile label="原価" value={view.status === "ok" ? yen(summary.totalCost) : "—"} />
          <SummaryTile label="粗利益" value={view.status === "ok" ? yen(summary.totalProfit) : "—"} />
          <SummaryTile label="原価率" value={view.status === "ok" ? `${summary.costRate.toFixed(1)}%` : "—"} />
          <SummaryTile label="送料（参考・原価には含みません）" value={view.status === "ok" ? yen(summary.totalShipping) : "—"} />
          <SummaryTile label="販売件数" value={view.status === "ok" ? `${summary.count}件` : "—"} />
          <SummaryTile label="平均販売単価" value={view.status === "ok" ? yen(Math.round(summary.averageSalePrice)) : "—"} />
        </div>

        <div className="mb-6 max-w-3xl border border-gray-200 p-3">
          <p className="mb-2 text-[11px] font-bold text-gray-400">直近12ヶ月の推移</p>
          <SalesTrendChart points={view.trend} />
        </div>

        {/* 対象商品一覧(明細)。ユーザーが明示的に開くまでInventoryへは
            アクセスしない(SalesItemsSection参照)。 */}
        <SalesItemsSection key={`${year}-${month}`} year={year} month={month} />
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-3 py-2.5">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="mt-0.5 text-[16px] font-bold tabular-nums text-gray-900">{value}</p>
    </div>
  );
}
