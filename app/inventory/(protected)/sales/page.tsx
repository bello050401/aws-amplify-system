import Link from "next/link";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listAllInventory } from "@/lib/inventory/queries";
import { summarizeSales, shiftYearMonth, type SalesSummary } from "@/lib/inventory/sales";
import { InventoryHeader } from "../../InventoryHeader";

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

  const now = new Date();
  const year = Number(searchParams.y) || now.getFullYear();
  const monthRaw = Number(searchParams.m) || now.getMonth() + 1;
  const month = monthRaw >= 1 && monthRaw <= 12 ? monthRaw : now.getMonth() + 1;

  const records = await listAllInventory();
  const summary: SalesSummary = summarizeSales(records, year, month);

  function monthHref(y: number, m: number): string {
    return `/inventory/sales?y=${y}&m=${m}`;
  }

  const prev = shiftYearMonth(year, month, -1);
  const next = shiftYearMonth(year, month, 1);
  const thisMonth = { year: now.getFullYear(), month: now.getMonth() + 1 };
  const lastMonth = shiftYearMonth(thisMonth.year, thisMonth.month, -1);
  const isCurrent = year === thisMonth.year && month === thisMonth.month;

  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">売上</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* 年月ナビゲーション(spec §12: 前月/翌月/今月/先月を簡単に選択可能) */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Link href={monthHref(prev.year, prev.month)} className="border border-gray-300 px-2 py-1 text-[12px] text-gray-600 hover:bg-gray-50">
            ← 前月
          </Link>
          <span className="min-w-[96px] border border-gray-200 bg-gray-50 px-3 py-1 text-center text-[14px] font-bold text-gray-900">
            {summary.year}年{summary.month}月
          </span>
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

        {/* 集計サマリー */}
        <div className="mb-6 grid max-w-3xl grid-cols-2 gap-px border border-gray-200 bg-gray-200 sm:grid-cols-3">
          <SummaryTile label="売上高" value={yen(summary.totalSales)} />
          <SummaryTile label="購入金額" value={yen(summary.totalPurchase)} />
          <SummaryTile label="送料" value={yen(summary.totalShipping)} />
          <SummaryTile label="原価" value={yen(summary.totalCost)} />
          <SummaryTile label="原価率" value={`${summary.costRate.toFixed(1)}%`} />
          <SummaryTile label="販売件数" value={`${summary.count}件`} />
          <SummaryTile label="平均販売単価" value={yen(Math.round(summary.averageSalePrice))} />
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
                  <th className="px-2 py-1.5 text-right font-normal">購入価格</th>
                  <th className="px-2 py-1.5 text-right font-normal">送料</th>
                  <th className="px-2 py-1.5 text-right font-normal">原価</th>
                </tr>
              </thead>
              <tbody>
                {summary.items.map((item) => {
                  const cost = (item.purchasePrice ?? 0) + (item.shippingCost ?? 0);
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
                      <td className="px-2 py-1 text-right tabular-nums">{item.purchasePrice !== null ? yen(item.purchasePrice) : "-"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{item.shippingCost !== null ? yen(item.shippingCost) : "-"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{yen(cost)}</td>
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
