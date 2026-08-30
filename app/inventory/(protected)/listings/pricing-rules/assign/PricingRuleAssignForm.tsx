"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { bulkAssignPricingRuleAction, type BulkAssignPricingRuleItemResult } from "@/app/actions/pricing";
import { loadPricingAssignmentSelection, clearPricingAssignmentSelection } from "@/lib/listing/pricingAssignmentSelection";
import type { PricingRuleRecord } from "@/lib/listing/pricing";
import type { ListingOverviewRow } from "@/lib/listing/service";

/**
 * 第六ラウンド§14-16(P0-3): EC出品一覧から選択した商品への自動値下げ
 * ルール一括適用フォーム。
 *
 * §128「選択商品数・対象channel・現在ルールを確認」§130「適用前に確認
 * summary。適用後は商品単位success/failure。」§131「商品単位かchannel
 * listing単位か既存モデルを調査し曖昧にしない」——調査結果:
 * pricingRuleId/autoPricingEnabledはChannelListingが保持する
 * (amplify/data/resource.tsのChannelListingモデル参照)。現状チャネルは
 * MERCARI_SHOPSのみ実装されているため(lib/listing/pricingService.tsの
 * setAutoPricingForListingも同様に固定)、このフォームも同じ前提を
 * 明示する——将来複数チャネルに拡張する際はここも合わせて拡張が必要。
 */
export function PricingRuleAssignForm({ rules, rows }: { rules: PricingRuleRecord[]; rows: ListingOverviewRow[] }) {
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [pricingRuleId, setPricingRuleId] = useState<string>("");
  const [autoPricingEnabled, setAutoPricingEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ items: BulkAssignPricingRuleItemResult[]; successCount: number; failureCount: number } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setSelectedIds(loadPricingAssignmentSelection());
  }, []);

  const selectedRows = useMemo(() => {
    if (!selectedIds) return [];
    const rowsById = new Map(rows.map((r) => [r.inventoryId, r] as const));
    return selectedIds.map((id) => rowsById.get(id)).filter((r): r is ListingOverviewRow => r != null);
  }, [selectedIds, rows]);

  // §128: まだChannelListingが無い商品(=まだ出品準備が始まっていない
  // 商品)は、setAutoPricingForListing自体が「先にMercariのカテゴリー
  // 設定を保存してください」で失敗する既存の仕様(lib/listing/
  // pricingService.ts)——適用前にここで見えるようにしておく(§143)。
  const withoutChannelListingCount = selectedRows.filter((r) => !r.channelListing).length;

  async function handleApply() {
    if (!selectedIds || selectedIds.length === 0 || !pricingRuleId) return;
    setBusy(true);
    setErrorMessage(null);
    setResults(null);
    try {
      const result = await bulkAssignPricingRuleAction(selectedIds, { pricingRuleId, autoPricingEnabled, automationHold: false });
      if (!result.ok) {
        setErrorMessage(result.error);
        return;
      }
      setResults({ items: result.data.results, successCount: result.data.successCount, failureCount: result.data.failureCount });
      clearPricingAssignmentSelection();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "一括適用に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  if (selectedIds === null) return null; // sessionStorage読み込み前の一瞬(SSRとの不一致を避ける)

  if (selectedIds.length === 0) {
    return (
      <div className="max-w-lg text-[13px] text-gray-600">
        <p>選択情報が見つかりません。EC出品一覧から商品を選択し直してください。</p>
        <Link href="/inventory/listings" className="mt-2 inline-block text-blue-700 underline">
          EC出品一覧へ戻る
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-4 border border-gray-200 bg-gray-50 p-3 text-[13px]">
        <p className="font-bold text-gray-800">
          {selectedRows.length}件の商品を選択中(対象チャネル: Mercari Shops)
        </p>
        {withoutChannelListingCount > 0 && (
          <p className="mt-1 text-amber-700">
            うち{withoutChannelListingCount}件はまだ出品準備(Mercariカテゴリー設定)が未実施のため、この一括適用では失敗として記録されます——先に商品詳細のEC出品タブで準備を行ってください。
          </p>
        )}
        <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-gray-600">
          {selectedRows.map((r) => (
            <li key={r.inventoryId}>
              {r.name}（{r.displayId}）{r.channelListing?.pricingRuleId ? " — 現在ルール設定あり" : ""}
            </li>
          ))}
        </ul>
      </div>

      <div className="mb-4 space-y-3 border border-gray-200 p-3">
        <label className="block text-[12px] font-bold text-gray-700">
          適用するルール
          <select
            value={pricingRuleId}
            onChange={(e) => setPricingRuleId(e.target.value)}
            className="mt-1 block w-full border border-gray-300 px-2 py-1.5 text-[13px] focus:border-gray-500 focus:outline-none"
          >
            <option value="">選択してください</option>
            {/* optionの中身は式ひとつにまとめる — 子に式を並べるとReactが
                textノードを分割し、SSR/hydrationの境界で扱いが揺れる
                (SalesTrendChartの`<title>`で実際にhydrationが壊れていた)。 */}
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {`${r.name}${r.enabled ? "" : "（無効）"}`}
              </option>
            ))}
          </select>
        </label>
        {rules.length === 0 && (
          <p className="text-[12px] text-gray-500">
            まだルールが作成されていません。先に
            <Link href="/inventory/listings/pricing-rules" className="text-blue-700 underline">
              ルール一覧
            </Link>
            から作成してください。
          </p>
        )}
        <label className="flex items-center gap-2 text-[12px] text-gray-700">
          <input type="checkbox" checked={autoPricingEnabled} onChange={(e) => setAutoPricingEnabled(e.target.checked)} />
          この商品群で自動値下げを有効にする(オフの場合はルールの割当のみ行い、実行はしません)
        </label>
      </div>

      <button
        type="button"
        onClick={handleApply}
        disabled={busy || !pricingRuleId}
        className="bg-gray-900 px-4 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
      >
        {busy ? "適用中…" : `${selectedRows.length}件へ適用`}
      </button>

      {errorMessage && <p className="mt-2 text-[12px] text-red-600">{errorMessage}</p>}

      {results && (
        <div className="mt-4 border border-gray-200 p-3 text-[12px]">
          <p className="font-bold text-gray-800">
            適用完了: 成功{results.successCount}件 / 失敗{results.failureCount}件
          </p>
          {results.failureCount > 0 && (
            <ul className="mt-2 space-y-0.5 text-red-600">
              {results.items
                .filter((r) => !r.ok)
                .map((r) => {
                  const row = rows.find((row) => row.inventoryId === r.inventoryId);
                  return (
                    <li key={r.inventoryId}>
                      {row?.name ?? r.inventoryId}: {r.error}
                    </li>
                  );
                })}
            </ul>
          )}
          <Link href="/inventory/listings" className="mt-3 inline-block text-blue-700 underline">
            EC出品一覧へ戻る
          </Link>
        </div>
      )}
    </div>
  );
}
