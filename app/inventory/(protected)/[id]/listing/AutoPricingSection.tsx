"use client";

import { useEffect, useState } from "react";
import { listPricingRulesAction, runPricingCheckAction, setAutoPricingForListingAction } from "@/app/actions/pricing";
import type { ChannelListingRecord } from "@/lib/listing/types";
import type { PricingRuleRecord } from "@/lib/listing/pricing";

/**
 * BELLO統合業務OS指示書(2026-08-30) §18/§161: 商品ごとの自動値下げ
 * 設定。既定はOFF — ここで明示的にチェックを入れ、ルールを選んで保存
 * するまで、この商品が自動値下げされることは無い。
 *
 * 「今すぐ価格チェックを実行」は実際の動作確認・デバッグ用 — §22の
 * スケジューラが定期的に行う判定を、手動で1回だけ即座に試せる。
 *
 * ※このコメントは以前「スケジューラ(§22、未実装)」と書いていたが、
 *   それは誤り(陳腐化)になっている。amplify/functions/pricing-scheduler
 *   が実装済みで、AWS上でも毎時のEventBridge Schedulerで実際に稼働して
 *   いることを実測で確認済み。未実装なのはスケジューラそのものではなく、
 *   下記のとおり「Mercariへ実際の価格変更を送信する部分」だけである。
 *   ——「Stagingで見えなかった機能を未実装と誤判定して作り直さない」と
 *   いう方針のため、この区別は明示しておく。
 *
 * 実行結果はsafe/blockedの判定と、safeだった場合の「本来いくらへ
 * 値下げされるはずだったか」の試算までを表示するが、実際にMercari側の
 * 価格を変更するわけではない(lib/listing/pricingService.tsのファイル
 * 冒頭コメント参照 — Mercariのupdate系ミューテーションの実schemaが
 * 未確認のため、§157「fake success禁止」に従い実送信しない)。
 * ボタンのラベル・結果表示にもその旨を明記し、誤解を招かないようにする。
 */
export function AutoPricingSection({
  inventoryId,
  channelListing,
  onUpdated,
}: {
  inventoryId: string;
  channelListing: ChannelListingRecord;
  onUpdated: (updated: ChannelListingRecord) => void;
}) {
  const [rules, setRules] = useState<PricingRuleRecord[]>([]);
  const [enabled, setEnabled] = useState(channelListing.autoPricingEnabled);
  const [ruleId, setRuleId] = useState(channelListing.pricingRuleId ?? "");
  const [hold, setHold] = useState(channelListing.automationHold);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  useEffect(() => {
    listPricingRulesAction()
      .then((all) => setRules(all.filter((r) => r.enabled)))
      .catch(() => setRules([]));
  }, []);

  async function handleSave() {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await setAutoPricingForListingAction(inventoryId, {
        autoPricingEnabled: enabled,
        pricingRuleId: enabled ? ruleId || null : null,
        automationHold: hold,
      });
      onUpdated(updated);
      setMessage("保存しました。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function handleRunCheck() {
    setBusy(true);
    setCheckResult(null);
    try {
      const result = await runPricingCheckAction(inventoryId);
      if (!result.executed && result.wouldChangePriceTo == null) {
        setCheckResult(`実行しませんでした（理由: ${result.reason ?? "不明"}）。`);
      } else {
        setCheckResult(
          `判定OK — 本来なら¥${result.wouldChangePriceTo?.toLocaleString("ja-JP")}へ値下げされるはずですが、実際のMercari価格変更は未実装のため送信していません（判定結果のみ記録しました）。`,
        );
      }
    } catch (err) {
      setCheckResult(err instanceof Error ? err.message : "実行に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border border-gray-200 p-4">
      <p className="mb-2 text-[12px] font-bold text-gray-700">自動価格設定</p>
      <p className="mb-2 text-[11px] text-gray-500">
        有効にすると、選択したルールに従って一定期間ごとに自動で値下げされます（下限価格までで停止します）。既定は無効です。
      </p>

      <label className="flex items-center gap-2 text-[12px] text-gray-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        この商品に自動価格ルールを適用する
      </label>

      {enabled && (
        <div className="mt-2 pl-5">
          <label className="block text-[12px] text-gray-600">
            適用するルール
            <select
              value={ruleId}
              onChange={(e) => setRuleId(e.target.value)}
              className="mt-0.5 w-64 border border-gray-300 bg-white px-2 py-1 text-[13px]"
            >
              <option value="">未選択</option>
              {rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {rules.length === 0 && <p className="mt-1 text-[11px] text-gray-400">有効な自動価格ルールがありません。設定画面から作成してください。</p>}

          <label className="mt-2 flex items-center gap-2 text-[12px] text-gray-700">
            <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
            一時的に自動処理を止める（ルールは維持したまま停止）
          </label>

          {channelListing.floorPrice != null && (
            <dl className="mt-2 grid grid-cols-2 gap-y-0.5 text-[11px] text-gray-500">
              <dt>基準価格</dt>
              <dd>{channelListing.originalPrice != null ? `¥${channelListing.originalPrice.toLocaleString("ja-JP")}` : "-"}</dd>
              <dt>下限価格</dt>
              <dd>¥{channelListing.floorPrice.toLocaleString("ja-JP")}</dd>
              <dt>値下げ回数</dt>
              <dd>{channelListing.markdownCount}回</dd>
            </dl>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || (enabled && rules.length > 0 && !ruleId)}
          className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
        >
          {busy ? "保存中…" : "保存する"}
        </button>
        {channelListing.autoPricingEnabled && (
          <button
            type="button"
            onClick={handleRunCheck}
            disabled={busy}
            className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            今すぐ価格チェックを実行（テスト・実際には送信しません）
          </button>
        )}
      </div>

      {message && <p className="mt-2 text-[12px] text-gray-600">{message}</p>}
      {checkResult && <p className="mt-2 text-[12px] text-gray-600">{checkResult}</p>}

      {channelListing.lastAutomationResult && (
        <p className="mt-2 text-[11px] text-gray-400">前回の判定: {channelListing.lastAutomationResult}</p>
      )}
    </div>
  );
}
