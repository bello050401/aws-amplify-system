"use client";

import { useEffect, useMemo, useState } from "react";
import { getShippingReferencePriceAction } from "@/app/actions/shipping";
import type { GetShippingReferencePriceResult } from "@/lib/shipping/service";
import { SHIPPING_RANK_LABEL } from "@/lib/shipping/rank";
import type { ShippingMeasurementEvidence } from "@/lib/shipping/referencePrice";

/**
 * BELLO統合業務OS ZAICO級高速化・完成保証最大化版 §31/§46: 「送料込み
 * 参考価格」表示。§31.2の通り、主表示(参考総額)を大きく、内訳(販売
 * 予定金額・ランク・送料中央値)はグレー系の小さな補助情報として表示
 * する。plannedSalePriceそのものはこのコンポーネントから一切編集不可
 * ——常に読み取り専用の派生表示(§31冒頭「販売予定金額そのものを勝手
 * に書き換えない」)。
 *
 * 2026-09-02 指示書§13/§17で追加:
 *  - 「送料判定に使用した寸法・3辺合計・ランク」を必ず出す。どの寸法で
 *    判定されたのかが一目で分かることが要件。座面高やSH/AHのように
 *    **判定から除外した**寸法も、除外理由と一緒に出す(黙って無視すると
 *    「なぜこのランクなのか」が追えない)。
 *  - 代表3地域だけでなく、ShippingRateに登録されている**全地域**を
 *    展開して参照できるようにする。
 */
export function ShippingReferencePriceSection({ inventoryId }: { inventoryId: string }) {
  const [result, setResult] = useState<GetShippingReferencePriceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllRegions, setShowAllRegions] = useState(false);
  const [regionQuery, setRegionQuery] = useState("");

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

  const view = result && result.available ? result.view : null;
  // useMemoで包むのは、毎レンダーで新しい配列リテラルが生まれると
  // 下のuseMemoの依存が毎回変わってしまうため(絞り込みが無駄に走る)。
  const allRegions = useMemo(() => (view && view.status === "OK" ? view.allRegions : []), [view]);
  const filteredRegions = useMemo(() => {
    const q = regionQuery.trim();
    if (!q) return allRegions;
    return allRegions.filter((r) => r.prefecture.includes(q) || (r.area ?? "").includes(q));
  }, [allRegions, regionQuery]);

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

  if (!view) return null;

  if (view.status === "INSUFFICIENT_DATA") {
    return (
      <div className="mt-4 border border-gray-200 p-4">
        <p className="mb-1 text-[12px] font-bold text-gray-700">送料込み参考価格</p>
        <p className="text-[11px] text-gray-400">
          送料データ不足(検証済み料金が{view.availableRegionCount}地域のみ、{view.requiredRegionCount}地域以上で中央値を算出します)。設定画面の「配送料金」から料金を追加してください。
        </p>
        <MeasurementBlock measurement={view.measurement} />
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
        <dt>らくらく家財便</dt>
        <dd>{SHIPPING_RANK_LABEL[view.rank]}</dd>
        <dt>送料中央値</dt>
        <dd>¥{view.medianShipping.toLocaleString("ja-JP")}</dd>
      </dl>

      <MeasurementBlock measurement={view.measurement} />

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

      {/* §16/§17: 代表3地域のハードコードでデータの有無を判断しない。
          登録済みの全地域をここから必ず参照できるようにする。 */}
      <div className="mt-3 border-t border-gray-100 pt-2">
        <button
          type="button"
          onClick={() => setShowAllRegions((v) => !v)}
          className="text-[11px] font-bold text-gray-600 underline"
        >
          {showAllRegions ? "地域別送料を閉じる" : `地域別送料を表示（${allRegions.length}地域）`}
        </button>
        {showAllRegions && (
          <div className="mt-2">
            <input
              type="search"
              value={regionQuery}
              onChange={(e) => setRegionQuery(e.target.value)}
              placeholder="都道府県で絞り込み"
              className="mb-2 w-full border border-gray-200 px-2 py-1 text-[11px]"
            />
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="text-gray-400">
                    <th className="py-0.5 text-left font-normal">地域</th>
                    <th className="py-0.5 text-right font-normal">送料</th>
                    <th className="py-0.5 text-right font-normal">参考総額</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRegions.map((row) => (
                    <tr key={`${row.prefecture}/${row.area ?? ""}`} className="border-b border-gray-50">
                      <td className="py-0.5 text-gray-600">
                        {row.prefecture}
                        {row.area ? <span className="text-gray-400">（{row.area}）</span> : null}
                      </td>
                      {row.status === "UNAVAILABLE" ? (
                        <td className="py-0.5 text-right text-gray-400" colSpan={2}>
                          配送不可/要確認
                        </td>
                      ) : (
                        <>
                          <td className="py-0.5 text-right text-gray-500">¥{row.price.toLocaleString("ja-JP")}</td>
                          <td className="py-0.5 text-right font-medium text-gray-800">¥{row.total.toLocaleString("ja-JP")}</td>
                        </>
                      )}
                    </tr>
                  ))}
                  {filteredRegions.length === 0 && (
                    <tr>
                      <td className="py-1 text-gray-400" colSpan={3}>
                        該当する地域がありません。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 指示書§13の「計測根拠」。何cmをどこから読んで、何を除外して、
 * 3辺合計がいくつでどのランクになったのかを出す。
 */
function MeasurementBlock({ measurement }: { measurement: ShippingMeasurementEvidence | null }) {
  if (!measurement) return null;
  const excluded = measurement.axes.flatMap((a) => a.excluded.map((e) => ({ axis: a.label, ...e })));
  return (
    <div className="mt-3 border-t border-gray-100 pt-2">
      <p className="mb-1 text-[11px] font-bold text-gray-400">送料判定の根拠</p>
      <dl className="grid grid-cols-2 gap-y-0.5 text-[11px] text-gray-500">
        <dt>送料判定方法</dt>
        <dd>{measurement.method}</dd>
        <dt>判定に使用した寸法</dt>
        <dd className="tabular-nums">
          {measurement.axes.map((a) => `${a.label}${a.valueCm ?? "?"}`).join(" × ")} cm
        </dd>
        <dt>3辺合計</dt>
        <dd className="tabular-nums">{measurement.sumCm} cm</dd>
        <dt>らくらく家財便ランク</dt>
        <dd>{SHIPPING_RANK_LABEL[measurement.rank]}</dd>
        <dt>使用したInventory項目</dt>
        <dd>{measurement.inventoryFieldsUsed.join(" / ")}</dd>
      </dl>
      {excluded.length > 0 && (
        <p className="mt-1 text-[10px] leading-relaxed text-gray-400">
          送料判定から除外:{" "}
          {excluded.map((e) => `${e.axis}「${e.label}${e.valueCm}」（${e.reason}）`).join("、")}
        </p>
      )}
    </div>
  );
}
