"use client";

import { useEffect, useState } from "react";
import { getShippingReferencePriceAction } from "@/app/actions/shipping";
import type { GetShippingReferencePriceResult } from "@/lib/shipping/service";
import { SHIPPING_RANK_LABEL } from "@/lib/shipping/rank";

/**
 * BELLO統合業務OS ZAICO級高速化・完成保証最大化版 §31/§46: 「送料込み
 * 参考価格」表示。§31.2の通り、主表示(参考総額)を大きく、内訳(販売
 * 予定金額・ランク・送料中央値)はグレー系の小さな補助情報として表示
 * する。plannedSalePriceそのものはこのコンポーネントから一切編集不可
 * ——常に読み取り専用の派生表示(§31冒頭「販売予定金額そのものを勝手
 * に書き換えない」)。
 */
export function ShippingReferencePriceSection({ inventoryId }: { inventoryId: string }) {
  const [result, setResult] = useState<GetShippingReferencePriceResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getShippingReferencePriceAction(inventoryId)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "取得に失敗しました。");
      });
    return () => {
      cancelled = true;
    };
  }, [inventoryId]);

  if (error) return null; // 読み取り専用の補助表示——失敗しても出品作業自体をブロックしない
  if (!result) return null;

  if (!result.available) {
    return (
      <div className="mt-4 border border-gray-200 p-4">
        <p className="mb-1 text-[12px] font-bold text-gray-700">送料込み参考価格</p>
        <p className="text-[11px] text-gray-400">{result.reason}</p>
      </div>
    );
  }

  const { view } = result;
  if (view.status === "INSUFFICIENT_DATA") {
    return (
      <div className="mt-4 border border-gray-200 p-4">
        <p className="mb-1 text-[12px] font-bold text-gray-700">送料込み参考価格</p>
        <p className="text-[11px] text-gray-400">
          送料データ不足(検証済み料金が{view.availableRegionCount}地域のみ、{view.requiredRegionCount}地域以上で中央値を算出します)。設定画面の「配送料金」から料金を追加してください。
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 border border-gray-200 p-4">
      <p className="mb-1 text-[12px] font-bold text-gray-700">送料込み参考価格</p>
      <p className="text-[20px] font-bold text-gray-900">¥{view.referenceTotal.toLocaleString("ja-JP")}</p>
      <dl className="mt-1 grid grid-cols-2 gap-y-0.5 text-[11px] text-gray-400">
        <dt>販売予定金額</dt>
        <dd>¥{view.plannedPrice.toLocaleString("ja-JP")}</dd>
        <dt>家財おまかせ便</dt>
        <dd>{SHIPPING_RANK_LABEL[view.rank]}ランク</dd>
        <dt>送料中央値</dt>
        <dd>¥{view.medianShipping.toLocaleString("ja-JP")}</dd>
      </dl>

      <div className="mt-3 border-t border-gray-100 pt-2">
        <p className="mb-1 text-[11px] font-bold text-gray-400">地域別（代表地域）</p>
        <table className="w-full border-collapse text-[11px]">
          <tbody>
            {view.representativeRegions.map((row) =>
              "status" in row ? (
                <tr key={row.prefecture} className="border-b border-gray-50">
                  <td className="py-0.5 text-gray-600">{row.label}</td>
                  {/* 第六ラウンド§9/§84: 「データ不足」(未取得)と「配送不可/要確認」(公式がサービス対象外と明示)を混同しない */}
                  <td className="py-0.5 text-gray-400" colSpan={2}>
                    {row.status === "UNAVAILABLE" ? "配送不可/要確認" : "データ不足"}
                  </td>
                </tr>
              ) : (
                <tr key={row.prefecture} className="border-b border-gray-50">
                  <td className="py-0.5 text-gray-600">{row.label}</td>
                  <td className="py-0.5 text-right text-gray-500">¥{row.price.toLocaleString("ja-JP")}</td>
                  <td className="py-0.5 text-right font-medium text-gray-800">¥{row.total.toLocaleString("ja-JP")}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      {view.notableDifferenceRegions.length > 0 && (
        <div className="mt-3 border-t border-gray-100 pt-2">
          <p className="mb-1 text-[11px] font-bold text-gray-400">送料中央値との差額が¥2,000以上の地域</p>
          <table className="w-full border-collapse text-[11px]">
            <tbody>
              {view.notableDifferenceRegions.map((row) => (
                <tr key={row.label} className="border-b border-gray-50">
                  <td className="py-0.5 text-gray-600">{row.label}</td>
                  <td className="py-0.5 text-right text-gray-500">¥{row.price.toLocaleString("ja-JP")}</td>
                  <td className="py-0.5 text-right font-medium text-gray-800">¥{row.total.toLocaleString("ja-JP")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
