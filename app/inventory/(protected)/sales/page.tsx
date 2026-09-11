import Link from "next/link";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { loadSalesSummary } from "@/lib/inventory/salesView";
import { nowInJst, isCurrentJstYearMonth, calculateMonthEndForecast, shiftYearMonth, formatJstDateTime } from "@/lib/inventory/sales";
import { InventoryHeader } from "../../InventoryHeader";
import { YearMonthPicker } from "./YearMonthPicker";
import { SalesTrendChart } from "./SalesTrendChart";
import { SalesItemsSection } from "./SalesItemsSection";

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
 * 権限: ADMIN/EDITOR/VIEWERいずれも閲覧可能 — 個々のInventoryレコード
 * が持つ購入価格/送料はすでに商品詳細でVIEWERも読める値であり(既存の
 * 権限モデル)、それを月単位で合計して見せるだけなので新しい権限区分
 * は設けていない(エクスポート機能と同じ考え方)。
 *
 * ── 2026-09-11 追加修正(初回アクセスで在庫走査を起動しない) ────────
 *
 * この関数(ページ本体)が呼ぶのは lib/inventory/salesView.ts の
 * loadSalesSummary のみ——集計テーブル(SalesAggregateSnapshot)への
 * GetItem 1回だけで、Inventoryへは一切アクセスしない。以前はここで
 * 「集計が欠損している月はその場でInventory全件/月フィルタ付き走査」
 * というフォールバックをしていたため、集計が1ヶ月でも欠けていれば
 * 画面を開くだけで実質全件Scanが走っていた(通常運用でも普通に起きる
 * 状態)。いまは集計が無い/読めない月は「未集計」「取得エラー」と
 * 明示するだけで、Inventoryへは読みに行かない。
 *
 * 対象商品一覧(明細)はこのページの初期描画には含めない——下の
 * SalesItemsSection(クライアントコンポーネント)がユーザーの明示的な
 * 操作("明細を表示")を受けてServer Action経由でloadSalesItemsを呼ぶ。
 *
 * ── 2026-09-11 世代整合性修正(集計テーブルの再構築) ────────────
 *
 * loadSalesSummaryの内部実装が「月ごとの複数行(旧SalesMonthlyAggregate)」
 * から「全月ぶんをまとめた単一スナップショット(SalesAggregateSnapshot)」
 * へ置き換わった——12時間ごとの定期実行が複数月を横断する訂正の反映中に
 * 一部だけ失敗しても、この画面が新旧世代の混在した値を表示することは
 * 構造的に起きない(docs/sales-aggregate-snapshot-consistency-
 * 20260911.md参照)。このページ自体のコードは変わっていない。
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

  const view = await loadSalesSummary(year, month);
  const summary = view.totals;

  function monthHref(y: number, m: number): string {
    return `/inventory/sales?y=${y}&m=${m}`;
  }

  const prev = shiftYearMonth(year, month, -1);
  const next = shiftYearMonth(year, month, 1);
  const thisMonth = { year: jstNow.year, month: jstNow.month };
  const lastMonth = shiftYearMonth(thisMonth.year, thisMonth.month, -1);
  const isCurrent = isCurrentJstYearMonth(year, month);

  // 追加修正指示 §3-§8: 今月の売上着地予測。当月が"ok"(集計テーブル
  // から実際の値が取れている)のときにのみ計算する——"missing"/"error"
  // の状態から0円ベースで予測を計算すると、実際にはまだ集計されて
  // いないだけの月を「着地予測ゼロ」のように見せてしまうため。
  const forecast = isCurrent && view.status === "ok" ? calculateMonthEndForecast(summary.totalSales, year, month, jstNow.day) : null;

  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">売上</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
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

        {/* BELLO統合改修 master指示書(2026-08-29統合改修版) §20: 12ヶ月
            推移グラフ(売上高・粗利益)。集計が無い/取得エラーの月は
            折れ線を途切れさせて表示する(SalesTrendChart側)。 */}
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
