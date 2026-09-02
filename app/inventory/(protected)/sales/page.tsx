import Link from "next/link";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { loadSalesView } from "@/lib/inventory/salesView";
import {
  calculateItemGrossProfit,
  shiftYearMonth,
  nowInJst,
  isCurrentJstYearMonth,
  calculateMonthEndForecast,
  type SalesSummary,
} from "@/lib/inventory/sales";
import { InventoryHeader } from "../../InventoryHeader";
import { YearMonthPicker } from "./YearMonthPicker";
import { SalesTrendChart } from "./SalesTrendChart";

interface SalesPageProps {
  searchParams: { y?: string; m?: string };
}

/**
 * 売上画面 (夜間開発指示書 §12)。左サイドバーの「売上」から遷移。
 *
 * 集計基準は販売終了日(saleEndDate) — 指定年月に販売終了したInventory
 * を対象にする(空欄は対象外)。詳細検索とは別機能 — フィルタ条件を
 * 組み立てる詳細検索と違い、ここは「月を選ぶ」だけの固定フォーマット
 * の集計画面。
 *
 * 現在ページだけでなく該当Inventory全件を対象にするため、
 * lib/inventory/queries.tsのlistAllInventory(chunked全件走査、既存の
 * fetchAllForExport/詳細検索と同じパターン)を使う — 集計自体は
 * lib/inventory/sales.tsの純粋関数(summarizeSales)に任せ、この
 * ページはDB取得とUIの組み立てだけを行う。
 *
 * 権限: ADMIN/EDITOR/VIEWERいずれも閲覧可能 — 個々のInventoryレコード
 * が持つ購入価格/送料はすでに商品詳細でVIEWERも読める値であり(既存の
 * 権限モデル)、それを月単位で合計して見せるだけなので新しい権限区分
 * は設けていない(エクスポート機能と同じ考え方)。
 */
export default async function SalesPage({ searchParams }: SalesPageProps) {
  const role = await getInventoryRole();
  if (!role) return null;

  // 追加修正指示 §5: 「今日」「今月」の判定はすべてJST(Asia/Tokyo)基準
  // で行う — サーバーの実行タイムゾーン(AWS/Amplify Hostingは通常UTC)
  // にnew Date()の年/月/日をそのまま使うと、日本時間の夜間~早朝
  // (UTCでは日付が進む/戻る境界)に「今月」の判定や着地予測が実際とズレ
  // うる。lib/inventory/sales.tsのnowInJstがこのズレを吸収する。
  const jstNow = nowInJst();
  // 月と同じように年も検証する。以前は年だけ素通りで、URLを直接
  // 書き換えると「-5年8月」「99999年1月」「10000000000年3月」といった
  // 見出しがそのまま出ていた(実測)。前月/翌月リンクもその値を基準に
  // 作られるため、一度入ると抜け出しにくい。BELLOの創業より前や
  // 翌年より先の売上は存在しないので、その範囲外は今月へ戻す。
  const yearRaw = Number(searchParams.y);
  const year = Number.isInteger(yearRaw) && yearRaw >= 2000 && yearRaw <= jstNow.year + 1 ? yearRaw : jstNow.year;
  const monthRaw = Number(searchParams.m) || jstNow.month;
  const month = Number.isInteger(monthRaw) && monthRaw >= 1 && monthRaw <= 12 ? monthRaw : jstNow.month;

  // 2026-09-02 指示書§20: 画面を開くたびに在庫を全件読む状態をやめた。
  //
  //   合計と12ヶ月推移 … 月次集計(read model)から GetItem 13回
  //   その月の商品一覧 … その月のぶんだけ取得
  //
  // 集計が無い月は黙って0にせず、その場で計算する(数字は必ず正しく、
  // 遅いか速いかだけが変わる)。詳細は lib/inventory/salesView.ts。
  const view = await loadSalesView(year, month);
  const summary: SalesSummary = view.summary;
  const trendPoints = view.trend;

  function monthHref(y: number, m: number): string {
    return `/inventory/sales?y=${y}&m=${m}`;
  }

  const prev = shiftYearMonth(year, month, -1);
  const next = shiftYearMonth(year, month, 1);
  const thisMonth = { year: jstNow.year, month: jstNow.month };
  const lastMonth = shiftYearMonth(thisMonth.year, thisMonth.month, -1);
  const isCurrent = isCurrentJstYearMonth(year, month);

  // 追加修正指示 §3-§8: 今月の売上着地予測。現在表示中の年月がJSTで見た
  // 「今まさに進行中の月」の場合にのみ計算・表示する(§7: 過去の確定月
  // に着地予測を出すのは無意味なため) — 将来「月別の売上分析」機能を
  // 追加する際も、この isCurrent 分岐点を起点に拡張できる。
  const forecast = isCurrent ? calculateMonthEndForecast(summary.totalSales, year, month, jstNow.day) : null;

  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">売上</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* 年月ナビゲーション(spec §12: 前月/翌月/今月/先月を簡単に選択可能) */}
        {/* 集計をいつ作り直したか。合計が集計由来か、その場の計算かも
            隠さずに出す —— どちらでも数字は正しいが、「いつ時点の値か」
            は判断に関わる。 */}
        {view.servedFromAggregate && view.aggregateRebuiltAt && (
          <p className="mb-2 text-[11px] text-gray-400">
            集計は {view.aggregateRebuiltAt.slice(0, 16).replace("T", " ")} 時点のものです。
          </p>
        )}
        {!view.servedFromAggregate && (
          <p className="mb-2 text-[11px] text-gray-400">
            月次集計がまだ作られていないため、その場で計算しています（数値は同じです）。
          </p>
        )}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Link href={monthHref(prev.year, prev.month)} className="border border-gray-300 px-2 py-1 text-[12px] text-gray-600 hover:bg-gray-50">
            ← 前月
          </Link>
          <YearMonthPicker year={summary.year} month={summary.month} currentYear={jstNow.year} />
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
            のときだけ表示する — 過去月を見ている間は下の既存サマリー
            (実績のみ)がそのまま表示される。派手なダッシュボード風には
            せず、既存のSummaryTileと同じ地味なグリッドのまま追加する
            (§6: 「派手なダッシュボードにはしない」)。
            BELLO統合改修 master指示書(2026-08-29統合改修版) §19: 「今月
            の売上」タイルは、すぐ下のサマリーの「売上高」タイルと同じ
            値(summary.totalSales)を別の呼び名で重複表示していただけ
            だったため撤去した — 冗長なラベルは一本化する、という
            spec §19の要件そのもの。 */}
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

        {/* 集計サマリー。
            追加修正(原価計算の新運用への統一): 原価(totalCost)は
            purchasePrice合計のみ(= totalPurchaseと同値)になったため、
            「購入金額」と「原価」を別タイルとして両方出すと同じ数字が
            重複表示されて紛らわしい — 「購入金額」タイルは廃止し「原価」
            へ一本化した。「送料」は過去データの参照用として残すが、
            原価には一切含まれないことが分かるよう「（参考）」を明示。
            BELLO統合改修 master指示書(2026-08-29統合改修版) Q15/§19:
            「利益」ではなく必ず「粗利益」と表示する — このアプリの
            どの画面でも「利益」という表記単独では使わない。 */}
        <div className="mb-6 grid max-w-3xl grid-cols-2 gap-px border border-gray-200 bg-gray-200 sm:grid-cols-3">
          <SummaryTile label="売上高" value={yen(summary.totalSales)} />
          <SummaryTile label="原価" value={yen(summary.totalCost)} />
          <SummaryTile label="粗利益" value={yen(summary.totalProfit)} />
          <SummaryTile label="原価率" value={`${summary.costRate.toFixed(1)}%`} />
          <SummaryTile label="送料（参考・原価には含みません）" value={yen(summary.totalShipping)} />
          <SummaryTile label="販売件数" value={`${summary.count}件`} />
          <SummaryTile label="平均販売単価" value={yen(Math.round(summary.averageSalePrice))} />
        </div>

        {/* BELLO統合改修 master指示書(2026-08-29統合改修版) §20: 12ヶ月
            推移グラフ(売上高・粗利益)。表示中の月を最終月とする直近
            12ヶ月 — 月を切り替えるたびにグラフの範囲も追従する。 */}
        <div className="mb-6 max-w-3xl border border-gray-200 p-3">
          <p className="mb-2 text-[11px] font-bold text-gray-400">直近12ヶ月の推移</p>
          <SalesTrendChart points={trendPoints} />
        </div>

        {/* 対象商品一覧 */}
        <p className="mb-1.5 text-[11px] font-bold text-gray-400">対象商品（{summary.items.length}件）</p>
        {summary.items.length === 0 ? (
          <p className="border border-gray-200 px-3 py-6 text-center text-[13px] text-gray-400">
            {summary.year}年{summary.month}月に販売終了した在庫はありません。
          </p>
        ) : (
          <div className="max-w-4xl border border-gray-200">
            <table className="w-full border-collapse text-[13px]">
              <thead className="bg-gray-50 text-[11px] text-gray-500">
                <tr className="border-b border-gray-200">
                  <th className="px-2 py-1.5 text-left font-normal">在庫ID</th>
                  <th className="px-2 py-1.5 text-left font-normal">SKU</th>
                  <th className="px-2 py-1.5 text-left font-normal">商品名</th>
                  <th className="px-2 py-1.5 text-left font-normal">販売終了日</th>
                  <th className="px-2 py-1.5 text-right font-normal">販売価格</th>
                  <th className="px-2 py-1.5 text-right font-normal">送料（参考）</th>
                  <th className="px-2 py-1.5 text-right font-normal">原価</th>
                  <th className="px-2 py-1.5 text-right font-normal">粗利益</th>
                </tr>
              </thead>
              <tbody>
                {summary.items.map((item) => {
                  // BELLO統合改修 master指示書(2026-08-29統合改修版) §21:
                  // 「一つの中央計算から算出する」— この行の粗利益も、
                  // 月合計(summary.totalProfit)と全く同じ
                  // lib/inventory/sales.tsのcalculateItemGrossProfitを
                  // 呼ぶ。原価=purchasePriceのみで、shippingCostを重ねて
                  // 加算しない(二重計上防止)というルールもこの1関数に
                  // 集約されている。
                  const cost = item.purchasePrice ?? 0;
                  const profit = calculateItemGrossProfit(item.salePrice, item.purchasePrice);
                  return (
                    <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-2 py-1">
                        <Link href={`/inventory/${item.id}`} className="font-mono text-[12px] text-gray-700 hover:underline">
                          {item.displayId}
                        </Link>
                      </td>
                      <td className="px-2 py-1 font-mono text-[12px] text-gray-500">{item.sku}</td>
                      <td className="px-2 py-1">
                        <Link href={`/inventory/${item.id}`} className="text-gray-900 hover:underline">
                          {item.name}
                        </Link>
                      </td>
                      <td className="px-2 py-1 text-gray-600">{item.saleEndDate.replace(/-/g, "/")}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{item.salePrice !== null ? yen(item.salePrice) : "-"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{item.shippingCost !== null ? yen(item.shippingCost) : "-"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{item.purchasePrice !== null ? yen(cost) : "-"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{yen(profit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
