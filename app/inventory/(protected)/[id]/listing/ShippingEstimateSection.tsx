"use client";

import { useState } from "react";
import { calculateShippingEstimateAction, confirmShippingFeeAction } from "@/app/actions/shipping";
import type { ChannelListingRecord } from "@/lib/listing/types";
import { SHIPPING_RANK_LABEL } from "@/lib/shipping/rank";
import { JAPAN_PREFECTURES, SHIPPING_ORIGIN_PREFECTURE } from "@/lib/shipping/prefectures";

/**
 * BELLO統合業務OS指示書(2026-08-30) §67-68: EC出品画面の送料見積り
 * セクション。§67のモック通り「発送元(固定)/サイズ(Inventoryから
 * 自動)/ランク(自動計算)/発送先(選択)/送料(参照)」を表示する。
 *
 * §68: calculated shipping(自動見積り)とconfirmed shipping(人が確定
 * させた値)を区別する — AI返信案生成(§69)はconfirmedを優先して使う。
 * 発送先は実際の購入者住所ではなく「見積り用の代表都道府県」であり、
 * その旨をUIに明記する(誤解防止)。
 */
export function ShippingEstimateSection({
  inventoryId,
  channelListing,
  onUpdated,
}: {
  inventoryId: string;
  channelListing: ChannelListingRecord;
  onUpdated: (updated: ChannelListingRecord) => void;
}) {
  const [destination, setDestination] = useState(channelListing.shippingDestinationPrefecture ?? "東京都");
  const [confirmedInput, setConfirmedInput] = useState(channelListing.confirmedShippingFee?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleCalculate() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await calculateShippingEstimateAction(inventoryId, destination);
      onUpdated(result.channelListing);
      if (!result.rank) {
        setMessage("幅・奥行・高さが未入力のため、ランクを判定できませんでした。商品詳細で寸法を入力してください。");
      } else if (!result.rateFound) {
        setMessage(result.reason ?? "該当する料金がまだ登録されていません。");
      } else {
        setMessage("見積りを更新しました。");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "計算に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setBusy(true);
    setMessage(null);
    try {
      const fee = confirmedInput.trim() === "" ? null : Number(confirmedInput);
      const updated = await confirmShippingFeeAction(inventoryId, fee != null && Number.isFinite(fee) ? fee : null);
      onUpdated(updated);
      setMessage("確定送料を保存しました。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border border-gray-200 p-4">
      <p className="mb-2 text-[12px] font-bold text-gray-700">送料見積り（家財おまかせ便）</p>
      <p className="mb-2 text-[11px] text-gray-500">
        発送元は{SHIPPING_ORIGIN_PREFECTURE}固定です。発送先は実際の購入者住所ではなく、見積り確認用の代表都道府県を選んでください。
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[12px] text-gray-600">
          発送先（見積り用）
          <select
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            className="mt-0.5 block w-40 border border-gray-300 bg-white px-2 py-1 text-[13px]"
          >
            {JAPAN_PREFECTURES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={handleCalculate}
          disabled={busy}
          className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {busy ? "計算中…" : "概算送料を計算"}
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-y-0.5 text-[11px] text-gray-500">
        <dt>サイズランク</dt>
        <dd>{channelListing.shippingRank ? SHIPPING_RANK_LABEL[channelListing.shippingRank] : "未計算"}</dd>
        <dt>概算送料（自動計算）</dt>
        <dd>{channelListing.calculatedShippingFee != null ? `¥${channelListing.calculatedShippingFee.toLocaleString("ja-JP")}` : "-"}</dd>
      </dl>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <label className="text-[12px] text-gray-600">
          確定送料（人が確認した金額。AI返信案作成ではこちらを優先して使います）
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-[13px] text-gray-500">¥</span>
            <input
              type="number"
              min={0}
              value={confirmedInput}
              onChange={(e) => setConfirmedInput(e.target.value)}
              placeholder="未確定"
              className="w-28 border border-gray-300 px-2 py-1 text-[13px]"
            />
            <button
              type="button"
              onClick={handleConfirm}
              disabled={busy}
              className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
            >
              確定送料として保存
            </button>
          </div>
        </label>
      </div>

      {message && <p className="mt-2 text-[12px] text-gray-600">{message}</p>}
    </div>
  );
}
