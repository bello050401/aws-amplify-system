"use client";
import { useEffect, useMemo, useState } from "react";
import { getShippingPackageQuoteDataAction } from "@/app/actions/shipping";
import {
  buildPackageQuote,
  type PackageQuoteData,
  type ShippingPackage,
} from "@/lib/shipping/packages";
import {
  COMMON_EC_CATEGORIES,
  COMMON_EC_CHANNELS,
  COMMON_EC_LABELS,
  commonCategory,
  suggestedChannelPrices,
  type CommonChannelPrices,
} from "@/lib/listing/commonSettings";
const field =
  "mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm";
export function CommonEcSettings({
  inventoryId,
  categoryId,
  onCategoryChange,
  prices,
  onPricesChange,
  goodsPrice,
  packages,
  shippingMethod,
}: {
  inventoryId: string;
  categoryId: string;
  onCategoryChange: (id: string) => void;
  prices: CommonChannelPrices | null;
  onPricesChange: (prices: CommonChannelPrices) => void;
  goodsPrice: number | null;
  packages: ShippingPackage[];
  shippingMethod: string;
}) {
  const [data, setData] = useState<PackageQuoteData | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    getShippingPackageQuoteDataAction(inventoryId)
      .then((v) => {
        if (live) setData(v);
      })
      .catch(() => {
        if (live)
          setError("送料を取得できませんでした。画面を開き直してください。");
      });
    return () => {
      live = false;
    };
  }, [inventoryId]);
  const quote = useMemo(
    () =>
      data && shippingMethod === "KAZAI"
        ? buildPackageQuote({
            ...data,
            packages,
            plannedPrice: goodsPrice,
            requireAllPrefectures: true,
          })
        : null,
    [data, packages, goodsPrice, shippingMethod],
  );
  const suggested = suggestedChannelPrices(
    goodsPrice,
    quote?.shippingTotal ?? null,
  );
  const selected = commonCategory(categoryId);
  return (
    <section
      aria-label="共通カテゴリと販売先別価格"
      className="space-y-4 rounded-lg border bg-gray-50 p-4"
    >
      <label className="block text-sm font-medium">
        商品カテゴリ
        <select
          aria-label="商品カテゴリ"
          value={categoryId}
          onChange={(e) => onCategoryChange(e.target.value)}
          className={field}
        >
          <option value="">カテゴリを選択</option>
          {COMMON_EC_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <details className="text-xs text-gray-600">
          <summary>販売先ごとのカテゴリを確認</summary>
          <ul className="mt-2 space-y-1">
            <li>メルカリShops：{selected.mercari.path}</li>
            <li>ヤフオク：{selected.yahoo.path}</li>
            <li>BASE：{selected.base.name}</li>
            <li>自社サイト：{selected.independent.name}</li>
          </ul>
        </details>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">販売先ごとの価格</h3>
        <button
          type="button"
          onClick={() => onPricesChange(suggested)}
          className="rounded border border-blue-600 bg-white px-3 py-2 text-xs text-blue-700"
        >
          基準価格と送料から設定
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {COMMON_EC_CHANNELS.map((c) => (
          <label key={c} className="block text-xs text-gray-600">
            {COMMON_EC_LABELS[c]}
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              className={field}
              value={prices?.[c] ?? ""}
              placeholder={
                suggested[c] == null ? "価格を入力" : String(suggested[c])
              }
              onChange={(e) =>
                onPricesChange({
                  ...(prices ?? suggested),
                  [c]: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <p className="text-xs text-gray-600">
        メルカリShopsは基準価格＋埼玉県から47都道府県への参考送料、BASEはその5％引きです。ヤフオクと自社サイトは送料別です。金額は個別に変更できます。
      </p>
      {quote && (
        <p className="text-xs text-gray-600">
          参考送料：
          {quote.shippingTotal === null
            ? "未算出（配送サイズ・料金を確認してください）"
            : `${quote.shippingTotal.toLocaleString("ja-JP")}円（${quote.packages.length}口合計）`}
          。北海道は4地域の中央値を1県分として計算します。
        </p>
      )}
    </section>
  );
}
