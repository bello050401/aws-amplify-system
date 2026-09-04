"use client";

import { useEffect, useState } from "react";
import {
  listShippingRatesAction,
  saveShippingRateAction,
  deleteShippingRateAction,
  exportShippingRatesCsvAction,
  importShippingRatesCsvAction,
} from "@/app/actions/shipping";
import type { ShippingRateRecord } from "@/lib/shipping/types";
import { SHIPPING_RANKS, SHIPPING_RANK_LABEL, type ShippingRank } from "@/lib/shipping/rank";
import { JAPAN_PREFECTURES, SHIPPING_ORIGIN_PREFECTURE } from "@/lib/shipping/prefectures";
import { KAZAI_PROVIDER_NAME, KAZAI_SERVICE_NAME } from "@/lib/shipping/serviceName";

const EMPTY_FORM = {
  // 呼称は lib/shipping/serviceName.ts が唯一の出所(2026-09-04)。
  provider: KAZAI_PROVIDER_NAME,
  service: KAZAI_SERVICE_NAME,
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

  // CSV一括更新。450件を1件ずつ直すのは現実的ではないので、書き出して
  // 直して戻せるようにする。取り込みは1行でも壊れていたら何も適用しない。
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvResult, setCsvResult] = useState<{ kind: "success" | "error"; text: string; lines?: string[] } | null>(null);

  async function handleExportCsv() {
    setCsvBusy(true);
    setCsvResult(null);
    try {
      const result = await exportShippingRatesCsvAction();
      if (!result.ok) {
        setCsvResult({ kind: "error", text: result.error });
        return;
      }
      // BOMを付ける。付けないとExcelが日本語を文字化けさせる。
      const blob = new Blob(["﻿" + result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `配送料金_${KAZAI_SERVICE_NAME}_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setCsvResult({ kind: "success", text: `${result.rows}件を書き出しました。` });
    } finally {
      setCsvBusy(false);
    }
  }

  async function handleImportCsv(file: File) {
    setCsvBusy(true);
    setCsvResult(null);
    try {
      const text = await file.text();
      const result = await importShippingRatesCsvAction(text);
      if (!result.ok) {
        setCsvResult({
          kind: "error",
          text: result.error,
          lines: result.lineErrors?.map((e) => `${e.line}行目: ${e.message}`),
        });
        return;
      }
      setCsvResult({
        kind: "success",
        text: `${result.applied}件を更新しました（変更なし ${result.unchanged}件 / 読み込み ${result.total}件）。`,
      });
      await reload();
    } catch (err) {
      setCsvResult({ kind: "error", text: err instanceof Error ? err.message : "CSVの取り込みに失敗しました。" });
    } finally {
      setCsvBusy(false);
    }
  }

  async function reload() {
    setRates(await listShippingRatesAction());
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
        <summary className="cursor-pointer">詳細（料金データの扱いについて）</summary>
        <p className="mt-1">
          配送料金はBELLO内部のこの表を正本として運用します。公式サイトからの自動取得は行いません（フォーム入力・セッション経由の動的な見積りで、安定して取得できないため）。
          料金を変更する場合はこの画面から編集し、出典欄に確認元（URLや確認日）を残してください。値引き計算・送料回答・AI返信案は、すべてこの表を参照します。
        </p>
      </details>

      <div className="mb-4 border border-gray-200 bg-gray-50 p-3 text-[12px]">
        <p className="mb-1 font-bold text-gray-700">CSVで一括更新</p>
        <p className="mb-2 text-[11px] text-gray-500">
          書き出したCSVを表計算で編集して取り込みます。<strong>1行でも問題があれば1件も更新しません。</strong>
          CSVに載っていない組合せは変更されません（削除は行いません）。配送不可の行は料金を空欄にし、「配送不可」列に1を入れてください。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleExportCsv()}
            disabled={csvBusy}
            className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-white disabled:opacity-50"
          >
            {csvBusy ? "処理中…" : "CSVを書き出す"}
          </button>
          <label className="cursor-pointer border border-gray-900 px-3 py-1 text-[12px] font-bold text-gray-900 hover:bg-white">
            CSVを取り込む
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              disabled={csvBusy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void handleImportCsv(file);
              }}
            />
          </label>
        </div>
        {csvResult && (
          <div className={`mt-2 border p-2 text-[11px] ${csvResult.kind === "success" ? "border-green-300 bg-green-50 text-green-800" : "border-red-300 bg-red-50 text-red-700"}`}>
            <p>{csvResult.text}</p>
            {csvResult.lines && csvResult.lines.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {csvResult.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </div>
        )}
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
