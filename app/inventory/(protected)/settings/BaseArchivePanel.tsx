"use client";

import { useEffect, useState } from "react";
import {
  getBaseArchiveStatusAction,
  rebuildStyleProfileAction,
  syncBaseArchiveAction,
  type BaseArchiveStatus,
} from "@/app/actions/baseArchive";

/**
 * 過去BASE商品の取り込み状況と、文体プロファイルの状態。
 *
 * この画面が何のためにあるか: 商品ページの自動生成は「BELLOが過去に
 * どう書いてきたか」を土台にしている。その土台が今どうなっているのか
 * (何件を分析したのか、いつの商品までか)が見えないと、生成結果の
 * 良し悪しを判断できない。
 */
export function BaseArchivePanel({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<BaseArchiveStatus | null>(null);
  const [busy, setBusy] = useState<"sync" | "profile" | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function reload() {
    const result = await getBaseArchiveStatusAction();
    if (result.ok) setStatus(result.data);
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleSync() {
    setBusy("sync");
    setMessage(null);
    try {
      const result = await syncBaseArchiveAction();
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setMessage({
        kind: "success",
        text: `${result.data.fetched}件を取得し、${result.data.saved}件を保存しました（紹介文あり ${result.data.withIntro}件${result.data.failed > 0 ? ` / 失敗 ${result.data.failed}件` : ""}）。`,
      });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function handleRebuild() {
    setBusy("profile");
    setMessage(null);
    try {
      const result = await rebuildStyleProfileAction();
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setMessage({
        kind: "success",
        text: `文体プロファイル v${result.data.version} を作成しました（分析 ${result.data.analyzed}件 / 確からしさ ${result.data.confidence}）。`,
      });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 border-t border-gray-200 pt-4">
      <p className="mb-1 text-[12px] font-bold text-gray-700">過去BASE商品の分析</p>
      <p className="mb-2 text-[11px] text-gray-500">
        BELLOが過去にBASEへ書いた商品説明を取り込み、文体を分析します。商品ページの自動生成はこの分析結果を土台にします。
        <strong>BASEからの読み取りのみで、BASEへは何も書き込みません。</strong>
      </p>

      {message && (
        <p className={`mb-2 border p-2 text-[12px] ${message.kind === "success" ? "border-green-300 bg-green-50 text-green-800" : "border-red-300 bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}

      <div className="mb-2 space-y-0.5 text-[11px] text-gray-600">
        <p>
          取り込み済みの過去商品:{" "}
          <span className="font-bold text-gray-900">{status ? `${status.archivedItems}件` : "確認中…"}</span>
          {status && status.archivedItems > 0 && <>（説明文あり {status.withIntro}件）</>}
        </p>
        {status?.periodStart && (
          <p>
            対象期間: {new Date(status.periodStart).toLocaleDateString("ja-JP")} 〜{" "}
            {status.periodEnd ? new Date(status.periodEnd).toLocaleDateString("ja-JP") : ""}
          </p>
        )}
        {status?.lastSyncedAt && <p>最終取り込み: {new Date(status.lastSyncedAt).toLocaleString("ja-JP")}</p>}
        <p>
          文体プロファイル:{" "}
          {status?.styleProfileVersion ? (
            <span className="text-gray-900">
              v{status.styleProfileVersion}（分析 {status.styleProfileAnalyzedItems}件 / 確からしさ {status.styleProfileConfidence}）
            </span>
          ) : (
            <span className="text-amber-600">未作成</span>
          )}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={busy !== null || !connected}
          title={connected ? undefined : "BASEアカウントとの連携が必要です"}
          className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          {busy === "sync" ? "取り込み中…" : "BASE商品を取り込む"}
        </button>
        <button
          type="button"
          onClick={() => void handleRebuild()}
          disabled={busy !== null || !status || status.archivedItems === 0}
          className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          {busy === "profile" ? "分析中…" : "文体を分析し直す"}
        </button>
      </div>
      {!connected && (
        <p className="mt-1 text-[11px] text-amber-600">BASEアカウントとの連携が完了すると取り込みできます。</p>
      )}
    </div>
  );
}
