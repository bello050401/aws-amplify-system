"use client";

import { useEffect, useState } from "react";
import { listPricingRulesAction, savePricingRuleAction } from "@/app/actions/pricing";
import type { PricingRuleRecord, PricingMarkdownType, PricingFloorMode, PricingActionAtFloor } from "@/lib/listing/pricing";

const MARKDOWN_TYPE_LABEL: Record<PricingMarkdownType, string> = { FIXED_AMOUNT: "固定額", PERCENTAGE: "定率(%)" };
const FLOOR_MODE_LABEL: Record<PricingFloorMode, string> = { FIXED_AMOUNT: "固定額", PERCENTAGE_OF_ORIGINAL: "初回価格に対する割合(%)" };
const ACTION_AT_FLOOR_LABEL: Record<PricingActionAtFloor, string> = {
  KEEP: "そのまま維持",
  PAUSE: "出品を停止",
  RELIST: "再出品（未実装）",
  MANUAL_REVIEW: "手動確認を促す",
};

const EMPTY_FORM = {
  name: "",
  enabled: false,
  startAfterDays: 30,
  intervalDays: 14,
  markdownType: "PERCENTAGE" as PricingMarkdownType,
  markdownValue: 10,
  floorPriceMode: "PERCENTAGE_OF_ORIGINAL" as PricingFloorMode,
  floorPriceValue: 50,
  maxExecutions: 3,
  actionAtFloor: "PAUSE" as PricingActionAtFloor,
};

/**
 * BELLO統合業務OS指示書(2026-08-30) §17/§161: 自動値下げルールの管理
 * 画面。値下げ日数・率はBELLO独自の経営ルールであり将来変わりうるため
 * hardcodeせず、ここで作成・編集する。ルール自体・個別商品への割り当て
 * (ChannelListing.autoPricingEnabled)のどちらもenabled/ONにするまでは
 * 何も自動実行されない(§161「本番自動実行はdefault OFF」) — この画面
 * でルールを作るだけでは、どの商品もまだ値下げされない。
 *
 * 実際の外部API呼び出し(Mercariへの価格変更送信)は未実装
 * (lib/listing/pricingService.tsのファイル冒頭コメント参照) — この
 * ルール管理・商品ごとの割り当て・安全条件判定・監査ログまでが今回の
 * 実装範囲であることを、パネル内の注記で明示する(§155: 実装範囲を
 * こっそり縮小しない)。
 */
export function PricingRulePanel() {
  const [rules, setRules] = useState<PricingRuleRecord[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function reload() {
    setRules(await listPricingRulesAction());
  }

  useEffect(() => {
    void reload();
  }, []);

  function startNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setMessage(null);
    setShowForm(true);
  }

  function startEdit(rule: PricingRuleRecord) {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      enabled: rule.enabled,
      startAfterDays: rule.startAfterDays,
      intervalDays: rule.intervalDays,
      markdownType: rule.markdownType,
      markdownValue: rule.markdownValue,
      floorPriceMode: rule.floorPriceMode,
      floorPriceValue: rule.floorPriceValue,
      maxExecutions: rule.maxExecutions ?? 0,
      actionAtFloor: rule.actionAtFloor,
    });
    setMessage(null);
    setShowForm(true);
  }

  async function handleSave() {
    setBusy(true);
    setMessage(null);
    try {
      await savePricingRuleAction(editingId, { ...form, maxExecutions: form.maxExecutions > 0 ? form.maxExecutions : null });
      setMessage({ kind: "success", text: "保存しました。" });
      setShowForm(false);
      await reload();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "保存に失敗しました。" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(rule: PricingRuleRecord) {
    setBusy(true);
    try {
      await savePricingRuleAction(rule.id, {
        name: rule.name,
        enabled: !rule.enabled,
        startAfterDays: rule.startAfterDays,
        intervalDays: rule.intervalDays,
        markdownType: rule.markdownType,
        markdownValue: rule.markdownValue,
        floorPriceMode: rule.floorPriceMode,
        floorPriceValue: rule.floorPriceValue,
        maxExecutions: rule.maxExecutions,
        actionAtFloor: rule.actionAtFloor,
      });
      await reload();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "更新に失敗しました。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-2 text-[12px] text-gray-500">
        商品を一定期間ごとに自動で値下げするルールを作成します。ルールを作成・有効化しただけでは何も起こりません — 各商品のEC出品画面で個別に「自動価格ルールを有効にする」を選んだ商品だけが対象になります。
      </p>
      <details className="mb-3 text-[11px] text-gray-400">
        <summary className="cursor-pointer">詳細（現在の実装範囲について）</summary>
        <p className="mt-1">
          安全条件の判定・下限価格でのブロック・実行回数上限・監査ログ（商品詳細画面から確認可能）までは実際に動作します。ただし、Mercari
          Shopsへ実際の価格変更を送信するAPI呼び出し自体は、公式のGraphQL仕様がこの開発環境から確認できていないため未実装です。「今すぐ価格チェックを実行」は判定結果の記録のみを行い、実際の価格は変更しません。
        </p>
      </details>

      <div className="border border-gray-200">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-gray-50 text-[11px] text-gray-500">
            <tr className="border-b border-gray-200">
              <th className="px-2 py-1.5 text-left font-normal">ルール名</th>
              <th className="px-2 py-1.5 text-left font-normal">開始/間隔</th>
              <th className="px-2 py-1.5 text-left font-normal">値下げ幅</th>
              <th className="px-2 py-1.5 text-left font-normal">下限</th>
              <th className="px-2 py-1.5 text-left font-normal">有効</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {rules === null && (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-center text-gray-400">
                  読み込み中…
                </td>
              </tr>
            )}
            {rules?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-center text-gray-400">
                  まだルールがありません。
                </td>
              </tr>
            )}
            {rules?.map((rule) => (
              <tr key={rule.id} className="border-b border-gray-100">
                <td className="px-2 py-1.5">
                  <button type="button" onClick={() => startEdit(rule)} className="text-blue-700 underline">
                    {rule.name}
                  </button>
                </td>
                <td className="px-2 py-1.5 text-gray-600">
                  {rule.startAfterDays}日後 / {rule.intervalDays}日おき
                </td>
                <td className="px-2 py-1.5 text-gray-600">
                  {rule.markdownValue}
                  {rule.markdownType === "PERCENTAGE" ? "%" : "円"}
                </td>
                <td className="px-2 py-1.5 text-gray-600">
                  {rule.floorPriceValue}
                  {rule.floorPriceMode === "PERCENTAGE_OF_ORIGINAL" ? "%" : "円"}
                </td>
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => toggleEnabled(rule)}
                    disabled={busy}
                    className={`px-2 py-0.5 text-[11px] font-bold ${rule.enabled ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}
                  >
                    {rule.enabled ? "有効" : "無効"}
                  </button>
                </td>
                <td className="px-2 py-1.5"></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        {!showForm ? (
          <button type="button" onClick={startNew} className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50">
            新しいルールを作成
          </button>
        ) : (
          <div className="border border-gray-200 p-4">
            <p className="mb-2 text-[12px] font-bold text-gray-700">{editingId ? "ルールを編集" : "新しいルール"}</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 text-[12px] text-gray-600">
                ルール名
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px]"
                />
              </label>
              <label className="text-[12px] text-gray-600">
                開始まで（日）
                <input
                  type="number"
                  min={0}
                  value={form.startAfterDays}
                  onChange={(e) => setForm((f) => ({ ...f, startAfterDays: Number(e.target.value) }))}
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px]"
                />
              </label>
              <label className="text-[12px] text-gray-600">
                以降の間隔（日）
                <input
                  type="number"
                  min={1}
                  value={form.intervalDays}
                  onChange={(e) => setForm((f) => ({ ...f, intervalDays: Number(e.target.value) }))}
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px]"
                />
              </label>
              <label className="text-[12px] text-gray-600">
                値下げ方法
                <select
                  value={form.markdownType}
                  onChange={(e) => setForm((f) => ({ ...f, markdownType: e.target.value as PricingMarkdownType }))}
                  className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px]"
                >
                  {(Object.keys(MARKDOWN_TYPE_LABEL) as PricingMarkdownType[]).map((k) => (
                    <option key={k} value={k}>
                      {MARKDOWN_TYPE_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] text-gray-600">
                値下げ幅
                <input
                  type="number"
                  min={1}
                  value={form.markdownValue}
                  onChange={(e) => setForm((f) => ({ ...f, markdownValue: Number(e.target.value) }))}
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px]"
                />
              </label>
              <label className="text-[12px] text-gray-600">
                下限価格の指定方法
                <select
                  value={form.floorPriceMode}
                  onChange={(e) => setForm((f) => ({ ...f, floorPriceMode: e.target.value as PricingFloorMode }))}
                  className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px]"
                >
                  {(Object.keys(FLOOR_MODE_LABEL) as PricingFloorMode[]).map((k) => (
                    <option key={k} value={k}>
                      {FLOOR_MODE_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] text-gray-600">
                下限価格
                <input
                  type="number"
                  min={0}
                  value={form.floorPriceValue}
                  onChange={(e) => setForm((f) => ({ ...f, floorPriceValue: Number(e.target.value) }))}
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px]"
                />
              </label>
              <label className="text-[12px] text-gray-600">
                最大実行回数（0=無制限）
                <input
                  type="number"
                  min={0}
                  value={form.maxExecutions}
                  onChange={(e) => setForm((f) => ({ ...f, maxExecutions: Number(e.target.value) }))}
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px]"
                />
              </label>
              <label className="text-[12px] text-gray-600">
                下限到達時の動作
                <select
                  value={form.actionAtFloor}
                  onChange={(e) => setForm((f) => ({ ...f, actionAtFloor: e.target.value as PricingActionAtFloor }))}
                  className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px]"
                >
                  {(Object.keys(ACTION_AT_FLOOR_LABEL) as PricingActionAtFloor[]).map((k) => (
                    <option key={k} value={k}>
                      {ACTION_AT_FLOOR_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-2 flex items-center gap-2 text-[12px] text-gray-600">
                <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
                このルールを有効にする
              </label>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || !form.name.trim()}
                className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {busy ? "保存中…" : "保存する"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                disabled={busy}
                className="border border-gray-300 px-3 py-1 text-[12px] text-gray-600 hover:bg-gray-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        )}
      </div>

      {message && <p className={`mt-2 text-[12px] ${message.kind === "success" ? "text-green-700" : "text-red-600"}`}>{message.text}</p>}
    </div>
  );
}
