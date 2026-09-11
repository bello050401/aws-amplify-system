"use client";

import { useState } from "react";
import Link from "next/link";
import { getSalesItemsAction } from "@/app/actions/salesItems";
import { calculateItemGrossProfit, type SalesTargetItem } from "@/lib/inventory/sales";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; items: SalesTargetItem[] }
  | { kind: "error" };

/**
 * 対象商品一覧(明細)。2026-09-11追加修正「開いたとき即表示する」の
 * 核心部分——ページ本体(page.tsx)はここを描画するだけで、Inventoryへは
 * 一切アクセスしない。ユーザーがこのセクションを明示的に開いた
 * (ボタンを押した)ときだけ、Server Action(app/actions/salesItems.ts)
 * 経由でlib/inventory/salesView.tsのloadSalesItemsを呼ぶ。
 *
 * InventoryTotalCount.tsx(在庫総件数)はマウント時に自動fetchする設計
 * だが、あちらは「あると便利な付加情報」であり自動取得しても初期描画
 * をブロックしない性質の差だけの話——今回は「Inventory呼出そのものを
 * ユーザーの明示的操作まで一切起こさない」ことが要件そのものなので、
 * ここではuseEffectでの自動fetchをあえて使わない(マウント時発火は
 * 「明示的に開くまで取得しない」という要件に反する)。
 *
 * 年月を切り替えた(year/monthのprops自体が変わった)場合は、いま開いて
 * いる明細は前の月のものなので表示を保持せず閉じる——呼び出し側
 * (page.tsx)がkey={`${year}-${month}`}を渡してこのコンポーネントを
 * 丸ごと再マウントすることで、古い月の明細が新しい月の見出しの下に
 * 残らないようにしている(Reactの「keyでstateをリセットする」定石)。
 *
 * 2026-09-11 世代整合性修正でのQA検証: 通信そのものがreject(サーバー
 * 未到達・オフライン等でServer Actionのpromise自体が例外を投げる)する
 * ケースを実際にfetchが無い環境で再現し、catchが必ずerror状態へ遷移
 * して「再試行」ボタンから再度loadを呼べることを確認済み(下のcatchブ
 * ロック——Server Actionが`{ok:false}`を返す正常系の失敗経路とは別に、
 * catchがこの通信断のケースを担う)。
 */
export function SalesItemsSection({ year, month }: { year: number; month: number }) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  async function load() {
    setState({ kind: "loading" });
    try {
      const result = await getSalesItemsAction(year, month);
      if (result.ok) setState({ kind: "loaded", items: result.items });
      else setState({ kind: "error" });
    } catch {
      // 通信断ではServer Actionの戻り値を受け取れないため、再試行可能に戻す。
      setState({ kind: "error" });
    }
  }

  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-3">
        <p className="text-[11px] font-bold text-gray-400">
          対象商品{state.kind === "loaded" ? `（${state.items.length}件）` : ""}
        </p>
        {state.kind !== "loading" && (
          <button
            type="button"
            onClick={() => void load()}
            className="border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
          >
            {state.kind === "loaded" ? "再取得" : state.kind === "error" ? "再試行" : "明細を表示"}
          </button>
        )}
      </div>

      {state.kind === "idle" && (
        <p className="border border-gray-200 px-3 py-6 text-center text-[13px] text-gray-400">
          「明細を表示」を押すと、この月の対象商品を取得します。
        </p>
      )}

      {state.kind === "loading" && (
        <p className="border border-gray-200 px-3 py-6 text-center text-[13px] text-gray-400" aria-live="polite">
          取得中…
        </p>
      )}

      {state.kind === "error" && (
        <p className="border border-red-200 bg-red-50 px-3 py-6 text-center text-[13px] text-red-600" role="alert">
          明細の取得に失敗しました。「再試行」を押してください。
        </p>
      )}

      {state.kind === "loaded" && state.items.length === 0 && (
        <p className="border border-gray-200 px-3 py-6 text-center text-[13px] text-gray-400">
          {year}年{month}月に販売終了した在庫はありません。
        </p>
      )}

      {state.kind === "loaded" && state.items.length > 0 && (
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
              {state.items.map((item) => {
                // BELLO統合改修 master指示書(2026-08-29統合改修版) §21:
                // 「一つの中央計算から算出する」— この行の粗利益も
                // lib/inventory/sales.tsのcalculateItemGrossProfitを呼ぶ。
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
  );
}
