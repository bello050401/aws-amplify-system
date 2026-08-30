"use client";

import { useState } from "react";
import { generateSystemAuditReportAction } from "@/app/actions/systemAudit";

/**
 * §7: 「BELLO System Audit Report」をその場で生成し、コピーできるように
 * する画面。ChatGPT等の別AIへ全repositoryを渡さずに監査してもらうための
 * 出力窓口(§7冒頭コメント参照 — 秘密情報は含まれない設計)。
 */
export function SystemAuditPanel() {
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setReport(await generateSystemAuditReportAction());
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!report) return;
    await navigator.clipboard.writeText(report);
    setCopied(true);
  }

  return (
    <div className="max-w-3xl">
      <p className="mb-2 text-[12px] text-gray-500">
        AI利用状況・コスト・外部連携状況・既知の課題をまとめたMarkdownレポートを生成します。秘密鍵・トークン・個人情報は含まれません。生成後、ChatGPT等の別のAIへ貼り付けて監査を依頼できます。
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={busy}
          className="bg-gray-900 px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
        >
          {busy ? "生成中…" : "レポートを生成"}
        </button>
        {report && (
          <button type="button" onClick={handleCopy} className="border border-gray-300 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
            {copied ? "コピーしました" : "クリップボードへコピー"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
      {report && (
        <textarea readOnly value={report} rows={20} className="mt-3 w-full border border-gray-300 p-2 font-mono text-[11px] text-gray-700" />
      )}
    </div>
  );
}
