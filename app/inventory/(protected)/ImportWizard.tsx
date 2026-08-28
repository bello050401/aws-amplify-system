"use client";

import { useState } from "react";
import {
  executeInventoryImportAction,
  parseInventoryImportFileAction,
  previewInventoryImportAction,
} from "@/app/actions/inventoryImport";
import type { ImportExecuteResult, ImportSummary, ParsedImportFile } from "@/lib/inventory/inventoryImport";

type WizardStep = "file" | "mapping" | "result";

const STEP_LABELS: { key: WizardStep; label: string }[] = [
  { key: "file", label: "①ファイル" },
  { key: "mapping", label: "②内容確認" },
  { key: "result", label: "④結果" },
];

/**
 * インポートウィザード (統合改善指示書 §12/§20) — ①ファイル→②内容確
 * 認(マッピング+プレビュー)→③実行→④結果、の一直線のフロー。「③実行」
 * は②の画面上のボタン一つ(実行中はスピナー表示)として扱う — 独立した
 * 画面を持たせるほどの内容がないため。ファイル解析・プレビュー・実行
 * の3回のServer Action呼び出しのうち、実際にDBを書き換えるのは最後の
 * 実行(executeInventoryImportAction)だけ — spec §16「最終確認前にDBを
 * 書き換えない」。
 */
export function ImportWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<WizardStep>("file");
  const [sourceLabel, setSourceLabel] = useState<"CSVインポート" | "Excelインポート">("CSVインポート");
  const [parsed, setParsed] = useState<ParsedImportFile | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [result, setResult] = useState<ImportExecuteResult | null>(null);
  const [busy, setBusy] = useState<"idle" | "parsing" | "previewing" | "executing">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy("parsing");
    setSourceLabel(/\.xlsx$/i.test(file.name) ? "Excelインポート" : "CSVインポート");
    try {
      const fd = new FormData();
      fd.set("file", file);
      const result = await parseInventoryImportFileAction(fd);
      setParsed(result);
      setMapping(Object.fromEntries(Object.entries(result.suggestedMapping).map(([h, k]) => [h, k ?? ""])));
      setPreview(null);
      setStep("mapping");
    } catch (err) {
      setError(err instanceof Error ? err.message : "ファイルの解析に失敗しました。");
    } finally {
      setBusy("idle");
      e.target.value = ""; // 同じファイルを選び直しても再度onChangeが発火するように
    }
  }

  function mappingAsRecord(): Record<string, string> {
    return Object.fromEntries(Object.entries(mapping).filter(([, v]) => v));
  }

  async function handlePreview() {
    if (!parsed) return;
    setError(null);
    setBusy("previewing");
    try {
      setPreview(await previewInventoryImportAction(parsed.rows, mappingAsRecord()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "内容確認に失敗しました。");
    } finally {
      setBusy("idle");
    }
  }

  async function handleExecute() {
    if (!parsed) return;
    setError(null);
    setBusy("executing");
    try {
      const r = await executeInventoryImportAction(parsed.rows, mappingAsRecord(), sourceLabel);
      setResult(r);
      setStep("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "インポートの実行に失敗しました。");
    } finally {
      setBusy("idle");
    }
  }

  function reset() {
    setStep("file");
    setParsed(null);
    setMapping({});
    setPreview(null);
    setResult(null);
    setError(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col border border-gray-300 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5">
          <div className="flex items-center gap-3 text-[12px]">
            {STEP_LABELS.map((s) => (
              <span
                key={s.key}
                className={
                  s.key === step || (s.key === "mapping" && busy === "executing")
                    ? "font-bold text-gray-900"
                    : "text-gray-400"
                }
              >
                {s.label}
              </span>
            ))}
          </div>
          <button type="button" onClick={onClose} className="text-[12px] text-gray-500 hover:text-gray-900">
            閉じる
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && <p className="mb-3 border border-red-200 bg-red-50 px-2 py-1.5 text-[12px] text-red-700">{error}</p>}

          {step === "file" && (
            <div>
              <p className="mb-3 text-[12px] text-gray-500">
                CSV(.csv)またはExcel(.xlsx)ファイルを選択してください。BELLOからエクスポートしたファイルであれば、列の対応は自動的に提案されます。
              </p>
              <label className="flex cursor-pointer items-center justify-center border border-dashed border-gray-300 px-4 py-6 text-[13px] text-gray-500 hover:bg-gray-50">
                {busy === "parsing" ? "解析中…" : "クリックしてファイルを選択"}
                <input type="file" accept=".csv,.xlsx" onChange={handleFileChange} disabled={busy !== "idle"} className="hidden" />
              </label>
            </div>
          )}

          {step === "mapping" && parsed && (
            <div>
              <p className="mb-2 text-[12px] text-gray-500">
                {parsed.rows.length}行検出。各列がBELLOのどの項目に対応するか確認してください（「対応なし」の列は無視されます）。
              </p>
              <div className="max-h-64 overflow-y-auto border border-gray-200">
                <table className="w-full border-collapse text-[12px]">
                  <thead className="sticky top-0 bg-gray-50 text-gray-500">
                    <tr className="border-b border-gray-200">
                      <th className="px-2 py-1 text-left font-normal">ファイルの列</th>
                      <th className="px-2 py-1 text-left font-normal">サンプル値</th>
                      <th className="px-2 py-1 text-left font-normal">BELLO項目</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.headers.map((header) => (
                      <tr key={header} className="border-b border-gray-100">
                        <td className="px-2 py-1 text-gray-700">{header}</td>
                        <td className="max-w-[140px] truncate px-2 py-1 text-gray-400" title={parsed.rows[0]?.[header]}>
                          {parsed.rows[0]?.[header] || "-"}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            value={mapping[header] ?? ""}
                            onChange={(e) => {
                              setMapping((prev) => ({ ...prev, [header]: e.target.value }));
                              setPreview(null);
                            }}
                            className="w-full border border-gray-300 bg-white px-1 py-0.5 text-[12px] focus:border-gray-500 focus:outline-none"
                          >
                            <option value="">対応なし（無視）</option>
                            {parsed.mappingTargets.map((t) => (
                              <option key={t.key} value={t.key}>
                                {t.key === "sku" || t.key === "displayId" ? `${t.label}（既存商品との照合用）` : t.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {!preview ? (
                <button
                  type="button"
                  onClick={handlePreview}
                  disabled={busy !== "idle"}
                  className="mt-3 bg-gray-900 px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
                >
                  {busy === "previewing" ? "確認中…" : "内容を確認する"}
                </button>
              ) : (
                <div className="mt-3 border-t border-gray-100 pt-3">
                  <p className="mb-1.5 text-[11px] font-bold text-gray-400">プレビュー結果</p>
                  <dl className="grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
                    <dt className="text-gray-500">新規登録</dt>
                    <dd className="col-span-3">{preview.created}件</dd>
                    <dt className="text-gray-500">更新</dt>
                    <dd className="col-span-3">{preview.updated}件</dd>
                    <dt className="text-gray-500">スキップ（変更なし）</dt>
                    <dd className="col-span-3">{preview.unchanged}件</dd>
                    <dt className="text-gray-500">エラー</dt>
                    <dd className="col-span-3">{preview.errors.length}件</dd>
                  </dl>
                  {preview.errors.length > 0 && (
                    <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto border-t border-gray-100 pt-2 text-[11px] text-red-600">
                      {preview.errors.map((e, i) => (
                        <li key={i}>
                          {e.rowNumber}行目（{e.name}）：{e.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleExecute}
                      disabled={busy !== "idle" || (preview.created === 0 && preview.updated === 0)}
                      className="bg-gray-900 px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
                    >
                      {busy === "executing" ? "実行中…" : "実行する"}
                    </button>
                    {preview.errors.length > 0 && <span className="text-[11px] text-gray-400">エラー行はスキップされます</span>}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "result" && result && (
            <div>
              <p className="mb-2 text-[12px] font-bold text-gray-700">{sourceLabel}が完了しました。</p>
              <dl className="grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
                <dt className="text-gray-500">新規登録</dt>
                <dd className="col-span-3">{result.created}件</dd>
                <dt className="text-gray-500">更新</dt>
                <dd className="col-span-3">{result.updated}件</dd>
                <dt className="text-gray-500">スキップ（変更なし）</dt>
                <dd className="col-span-3">{result.unchanged}件</dd>
                <dt className="text-gray-500">エラー</dt>
                <dd className="col-span-3">{result.errors.length}件</dd>
              </dl>
              {result.errors.length > 0 && (
                <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto border-t border-gray-100 pt-2 text-[11px] text-red-600">
                  {result.errors.map((e, i) => (
                    <li key={i}>
                      {e.rowNumber}行目（{e.name}）：{e.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={reset} className="border border-gray-300 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
                  別のファイルをインポート
                </button>
                <button type="button" onClick={onClose} className="bg-gray-900 px-3 py-1.5 text-[12px] font-bold text-white">
                  閉じる
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
