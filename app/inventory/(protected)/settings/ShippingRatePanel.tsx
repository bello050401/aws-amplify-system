"use client";

import { useEffect, useState } from "react";
import { listShippingRatesAction, saveShippingRateAction, deleteShippingRateAction, runShippingRateImportAction, getLatestShippingImportBatchAction } from "@/app/actions/shipping";
import type { ShippingRateRecord } from "@/lib/shipping/types";
import type { ShippingImportBatchSummary } from "@/lib/shipping/importer";
import { SHIPPING_RANKS, SHIPPING_RANK_LABEL, type ShippingRank } from "@/lib/shipping/rank";
import { JAPAN_PREFECTURES, SHIPPING_ORIGIN_PREFECTURE } from "@/lib/shipping/prefectures";

const EMPTY_FORM = {
  provider: "アートセッティングデリバリー",
  service: "家財おまかせ便",
  destinationPrefecture: "東京都",
  rank: "B" as ShippingRank,
  price: 0,
  surcharge: 0,
  sourceReference: "",
};

/**
 * BELLO統合業務OS指示書(2026-08-30) §65-66: 家財おまかせ便の料金
 * マスタ管理画面。発送元は常に埼玉県固定(§61)、それ以外(発送先都道府
 * 県・ランク・金額・出典)をADMINが管理する。
 *
 * 【現状の実装範囲】ランク判定・見積り計算・AI返信への連携までは
 * すべて実装済みだが、実際の料金データは公式の料金検索ツール
 * (form.008008.jp)がJSフォーム/セッション経由の動的な見積りであり、
 * このsandbox開発環境からは到達できなかった(lib/shipping/ratesSeed.ts
 * のファイル冒頭コメント参照) — WebSearchで実際に確認できた埼玉→東京
 * のB/Cランクの2件のみを初期値として投入している。それ以外のランク・
 * 都道府県は、この画面で公式サイトの料金検索結果を見ながらADMINが
 * 追加する運用とした(憶測の金額を埋めて実装完了に見せかけることは
 * しない — §157)。
 */
export function ShippingRatePanel() {
  const [rates, setRates] = useState<ShippingRateRecord[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  // 第六ラウンド§11(P0-2): 埼玉発料金データの取得状況表示 + 「公式料金を更新」action。
  const [importBatch, setImportBatch] = useState<ShippingImportBatchSummary | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  async function reload() {
    setRates(await listShippingRatesAction());
  }

  async function reloadImportStatus() {
    const result = await getLatestShippingImportBatchAction();
    if (result.ok) setImportBatch(result.data);
  }

  async function handleRunImport() {
    setImportBusy(true);
    setImportMessage(null);
    try {
      const result = await runShippingRateImportAction();
      if (!result.ok) {
        setImportMessage(result.error);
        return;
      }
      setImportMessage(result.data.status === "COMPLETED" ? "取得処理が完了しました。" : `取得処理が失敗しました: ${result.data.reason ?? ""}`);
      await Promise.all([reload(), reloadImportStatus()]);
    } catch (err) {
      setImportMessage(err instanceof Error ? err.message : "公式料金の取得に失敗しました。");
    } finally {
      setImportBusy(false);
    }
  }

  useEffect(() => {
    void reload();
    void reloadImportStatus();
  }, []);

  function startNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setMessage(null);
    setShowForm(true);
  }

  function startEdit(rate: ShippingRateRecord) {
    setEditingId(rate.id);
    setForm({
      provider: rate.provider,
      service: rate.service,
      destinationPrefecture: rate.destinationPrefecture,
      rank: rate.rank,
      // 第六ラウンド§9/§84: UNAVAILABLE行(price=null)を編集フォームで
      // 開いた場合、0円という実在しない金額を暗示しないよう、フォーム上
      // は空欄相当の0から入力し直す運用とする(手動編集フォーム自体は
      // 「配送不可」入力をこのラウンドではサポートしない——UNAVAILABLE
      // 行はimporterだけが書く想定のため)。
      price: rate.price ?? 0,
      surcharge: rate.surcharge ?? 0,
      sourceReference: rate.sourceReference ?? "",
    });
    setMessage(null);
    setShowForm(true);
  }

  async function handleSave() {
    setBusy(true);
    setMessage(null);
    try {
      await saveShippingRateAction(editingId, {
        provider: form.provider,
        service: form.service,
        destinationPrefecture: form.destinationPrefecture,
        rank: form.rank,
        price: form.price,
        surcharge: form.surcharge > 0 ? form.surcharge : null,
        sourceReference: form.sourceReference.trim() || null,
      });
      setMessage({ kind: "success", text: "保存しました。" });
      setShowForm(false);
      await reload();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "保存に失敗しました。" });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(rate: ShippingRateRecord) {
    if (!confirm(`「${rate.destinationPrefecture}・${rate.rank}ランク」の料金を削除しますか？`)) return;
    setBusy(true);
    try {
      await deleteShippingRateAction(rate.id);
      await reload();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "削除に失敗しました。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-2 text-[12px] text-gray-500">
        発送元は{SHIPPING_ORIGIN_PREFECTURE}固定です。発送先都道府県・サイズランクごとの料金（税込）を登録すると、EC出品画面の送料見積り・AI返信案作成で使われます。
      </p>
      <details className="mb-3 text-[11px] text-gray-400">
        <summary className="cursor-pointer">詳細（料金データの出典について）</summary>
        <p className="mt-1">
          公式の料金検索ツールはフォーム入力・セッション経由の動的な見積りのため、この開発環境から自動取得できませんでした。初期値として、Web検索で実際に確認できた埼玉→東京のB/Cランクの2件のみを登録しています。それ以外の行は、公式サイト（アートセッティングデリバリー
          家財おまかせ便）の料金検索結果を確認のうえ、このフォームから追加してください。出典欄に確認元（URLや確認日）を残すことを推奨します。
        </p>
      </details>

      {/* 第六ラウンド§11: 埼玉発料金データの取得状況 + 「公式料金を更新」action。 */}
      <div className="mb-4 border border-gray-200 bg-gray-50 p-3 text-[12px]">
        <p className="mb-1 font-bold text-gray-700">埼玉発料金データ(公式Web取得)</p>
        {importBatch ? (
          <ul className="mb-2 space-y-0.5 text-gray-600">
            <li>最終実行: {importBatch.startedAt ? new Date(importBatch.startedAt).toLocaleString("ja-JP") : "-"}（status: {importBatch.status}）</li>
            <li>
              取得済み: {importBatch.verifiedCells}件 / 配送不可: {importBatch.unavailableCells}件 / 未取得: {importBatch.missingCells}件 / 失敗:{" "}
              {importBatch.failedCells}件
            </li>
            {importBatch.lastError && <li className="text-red-600">前回エラー: {importBatch.lastError}</li>}
          </ul>
        ) : (
          <p className="mb-2 text-gray-400">まだ実行履歴がありません。</p>
        )}
        <button
          type="button"
          onClick={handleRunImport}
          disabled={importBusy}
          className="border border-gray-900 px-3 py-1 text-[12px] font-bold text-gray-900 hover:bg-white disabled:opacity-50"
        >
          {importBusy ? "取得中…" : "公式料金を更新"}
        </button>
        {importMessage && <p className="mt-2 text-[11px] text-gray-600">{importMessage}</p>}
      </div>

      <div className="overflow-x-auto border border-gray-200">
        <table className="w-full min-w-[560px] border-collapse text-[13px]">
          <thead className="bg-gray-50 text-[11px] text-gray-500">
            <tr className="border-b border-gray-200">
              <th className="px-2 py-1.5 text-left font-normal">発送先</th>
              <th className="px-2 py-1.5 text-left font-normal">ランク</th>
              <th className="px-2 py-1.5 text-left font-normal">料金（税込）</th>
              <th className="px-2 py-1.5 text-left font-normal">加算</th>
              <th className="px-2 py-1.5 text-left font-normal">出典確認</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {rates === null && (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-center text-gray-400">
                  読み込み中…
                </td>
              </tr>
            )}
            {rates?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-center text-gray-400">
                  まだ料金が登録されていません。
                </td>
              </tr>
            )}
            {rates?.map((rate) => (
              <tr key={rate.id} className="border-b border-gray-100">
                <td className="px-2 py-1.5">
                  <button type="button" onClick={() => startEdit(rate)} className="text-blue-700 underline">
                    {rate.destinationPrefecture}
                  </button>
                </td>
                <td className="px-2 py-1.5 text-gray-600">{rate.rank}</td>
                <td className="px-2 py-1.5 text-gray-600">{rate.price != null ? `¥${rate.price.toLocaleString("ja-JP")}` : "配送不可/要確認"}</td>
                <td className="px-2 py-1.5 text-gray-600">{rate.surcharge != null ? `¥${rate.surcharge.toLocaleString("ja-JP")}` : "-"}</td>
                <td className="px-2 py-1.5 text-gray-400">{rate.verifiedAt ? "確認済み" : "未確認"}</td>
                <td className="px-2 py-1.5 text-right">
                  <button type="button" onClick={() => handleDelete(rate)} disabled={busy} className="text-[11px] text-red-600 hover:underline">
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        {!showForm ? (
          <button type="button" onClick={startNew} className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50">
            料金を追加
          </button>
        ) : (
          <div className="border border-gray-200 p-4">
            <p className="mb-2 text-[12px] font-bold text-gray-700">{editingId ? "料金を編集" : "新しい料金"}</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-[12px] text-gray-600">
                発送先都道府県
                <select
                  value={form.destinationPrefecture}
                  onChange={(e) => setForm((f) => ({ ...f, destinationPrefecture: e.target.value }))}
                  className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px]"
                >
                  {JAPAN_PREFECTURES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] text-gray-600">
                サイズランク
                <select
                  value={form.rank}
                  onChange={(e) => setForm((f) => ({ ...f, rank: e.target.value as ShippingRank }))}
                  className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px]"
                >
                  {SHIPPING_RANKS.map((r) => (
                    <option key={r} value={r}>
                      {SHIPPING_RANK_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] text-gray-600">
                料金（税込・円）
                <input
                  type="number"
                  min={0}
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: Number(e.target.value) }))}
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px]"
                />
              </label>
              <label className="text-[12px] text-gray-600">
                繁忙期加算等（円、無ければ0）
                <input
                  type="number"
                  min={0}
                  value={form.surcharge}
                  onChange={(e) => setForm((f) => ({ ...f, surcharge: Number(e.target.value) }))}
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px]"
                />
              </label>
              <label className="col-span-2 text-[12px] text-gray-600">
                出典（確認したURL・検索クエリ・確認日等）
                <input
                  value={form.sourceReference}
                  onChange={(e) => setForm((f) => ({ ...f, sourceReference: e.target.value }))}
                  placeholder="例: 公式料金検索ツールで2026-09-01に確認"
                  className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px]"
                />
              </label>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || form.price <= 0}
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
