"use client";

import { useRef, useState } from "react";
import {
  advanceZaicoSourceLinkBackfillAction,
  mergeZaicoDuplicateAction,
  runZaicoDuplicateAuditAction,
} from "@/app/actions/zaicoDuplicateAudit";
import type { ZaicoDuplicateAuditSummary, ZaicoDuplicateGroup } from "@/lib/inventory/zaicoDuplicateAudit";

/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.5/§11.9。
 *
 * 2段構成:
 *   1. リンク移行(ZaicoSourceLinkのバックフィル) — このラウンドより
 *      前に同期された既存ZAICO商品へ、O(1)ルックアップ用リンクを
 *      一度だけ作成する(lib/inventory/zaicoSourceLinkBackfill.ts参照、
 *      この過程自体が重複を検出する)。
 *   2. 全件監査 + 個別統合 — 実データを全走査してsourceInventoryIdの
 *      重複グループを一覧表示し、ADMINがグループごとに正規レコードを
 *      確認・選択して1件ずつ統合を実行する(「全部まとめて自動統合」
 *      ボタンは意図的に作らない——§11.9「必要な承認点だけ明示する」)。
 */
export function ZaicoDuplicateAuditPanel() {
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillDone, setBackfillDone] = useState(false);
  const [backfillScanned, setBackfillScanned] = useState(0);
  const [backfillCount, setBackfillCount] = useState(0);
  const [backfillDuplicates, setBackfillDuplicates] = useState(0);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const backfillNextTokenRef = useRef<string | null>(null);
  const backfillStopRef = useRef(false);

  const [auditRunning, setAuditRunning] = useState(false);
  const [audit, setAudit] = useState<ZaicoDuplicateAuditSummary | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [selectedCanonical, setSelectedCanonical] = useState<Record<string, string>>({});
  const [mergingKey, setMergingKey] = useState<string | null>(null);
  const [mergeResults, setMergeResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  async function runBackfillLoop() {
    setBackfillError(null);
    setBackfillRunning(true);
    setBackfillDone(false);
    backfillStopRef.current = false;
    setBackfillScanned(0);
    setBackfillCount(0);
    setBackfillDuplicates(0);
    backfillNextTokenRef.current = null;

    try {
      for (;;) {
        if (backfillStopRef.current) break;
        const res = await advanceZaicoSourceLinkBackfillAction(backfillNextTokenRef.current);
        if (!res.ok) {
          setBackfillError(res.error);
          break;
        }
        setBackfillScanned((n) => n + res.data.scanned);
        setBackfillCount((n) => n + res.data.backfilled);
        setBackfillDuplicates((n) => n + res.data.duplicatesFound);
        backfillNextTokenRef.current = res.data.nextToken;
        if (res.data.done) {
          setBackfillDone(true);
          break;
        }
      }
    } finally {
      setBackfillRunning(false);
    }
  }

  async function runAudit() {
    setAuditError(null);
    setAuditRunning(true);
    setMergeResults({});
    try {
      const res = await runZaicoDuplicateAuditAction();
      if (!res.ok) {
        setAuditError(res.error);
        return;
      }
      setAudit(res.data);
      const defaults: Record<string, string> = {};
      for (const g of res.data.groups) defaults[g.sourceInventoryId] = g.suggestedCanonicalId;
      setSelectedCanonical(defaults);
    } finally {
      setAuditRunning(false);
    }
  }

  async function handleMerge(group: ZaicoDuplicateGroup) {
    const canonicalId = selectedCanonical[group.sourceInventoryId] ?? group.suggestedCanonicalId;
    setMergingKey(group.sourceInventoryId);
    try {
      const res = await mergeZaicoDuplicateAction(group.sourceInventoryId, canonicalId);
      if (res.ok) {
        setMergeResults((m) => ({
          ...m,
          [group.sourceInventoryId]: {
            ok: true,
            message: `統合完了(重複レコード ${res.data.removedInventoryId} を削除、関連データを正規レコードへ引き継ぎ済み)。`,
          },
        }));
        await runAudit(); // 最新状態へ更新(同じグループに他の重複が残っていないか等)
      } else {
        setMergeResults((m) => ({ ...m, [group.sourceInventoryId]: { ok: false, message: res.error } }));
      }
    } finally {
      setMergingKey(null);
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-[12px] text-gray-500">
        ZAICO同期で同一ZAICO在庫IDが複数の在庫として重複登録される不具合の再発防止・既存重複の整理を行います。同期ロジック自体はDB層で新規重複を防ぐよう既に修正済みです——ここでは(1)過去に同期された既存商品への内部リンク移行、(2)現在の実データを対象にした重複監査・個別統合を行います。
      </p>

      <div className="border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">1. リンク移行(重複防止の内部索引)</p>
        <p className="mb-2 text-[11px] text-gray-500">
          この画面を開いている間、少しずつ処理します。既に移行済みの商品は自動的にスキップされるため、何度実行しても安全です。
        </p>
        <dl className="mb-3 grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
          <dt className="text-gray-500">確認した商品件数</dt>
          <dd className="col-span-3">{backfillScanned}</dd>
          <dt className="text-gray-500">新規リンク作成</dt>
          <dd className="col-span-3">{backfillCount}</dd>
          <dt className="text-gray-500">この過程で検出した重複</dt>
          <dd className="col-span-3">{backfillDuplicates > 0 ? <span className="font-bold text-amber-700">{backfillDuplicates}件 — 下の「2. 全件監査」で詳細を確認してください</span> : backfillDuplicates}</dd>
          {backfillDone && (
            <>
              <dt className="text-gray-500">状態</dt>
              <dd className="col-span-3 font-bold text-green-700">完了</dd>
            </>
          )}
        </dl>
        <div className="flex gap-2">
          <button type="button" onClick={runBackfillLoop} disabled={backfillRunning} className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50">
            {backfillRunning ? "実行中…" : backfillNextTokenRef.current || backfillDone ? "続きから実行" : "リンク移行を開始"}
          </button>
          {backfillRunning && (
            <button type="button" onClick={() => (backfillStopRef.current = true)} className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50">
              一時停止
            </button>
          )}
        </div>
        {backfillError && <p className="mt-2 text-[12px] text-red-600">{backfillError}</p>}
      </div>

      <div className="border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">2. 全件監査 + 個別統合</p>
        <p className="mb-2 text-[11px] text-gray-500">
          非削除の全在庫を走査し、同一ZAICO在庫IDが複数の在庫に紐づいているケースを一覧表示します。関連データ(出品下書き・EC出品・画像加工履歴・問い合わせ等)は削除せず正規レコードへ引き継いでから、重複レコードのみを削除します——一度に1グループずつ、確認のうえ実行してください。
        </p>
        <button type="button" onClick={runAudit} disabled={auditRunning} className="mb-3 bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50">
          {auditRunning ? "監査中…" : "監査を実行"}
        </button>
        {auditError && <p className="mb-2 text-[12px] text-red-600">{auditError}</p>}

        {audit && (
          <>
            <dl className="mb-4 grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
              <dt className="text-gray-500">在庫総件数</dt>
              <dd className="col-span-3">{audit.totalInventoryRecords}</dd>
              <dt className="text-gray-500">ZAICO連携件数</dt>
              <dd className="col-span-3">{audit.zaicoLinkedRecords}</dd>
              <dt className="text-gray-500">重複グループ数</dt>
              <dd className="col-span-3">{audit.duplicateGroupCount}</dd>
              <dt className="text-gray-500">重複の影響を受けているレコード数</dt>
              <dd className="col-span-3">{audit.duplicateAffectedRecordCount}</dd>
            </dl>

            {audit.duplicateGroupCount === 0 ? (
              <p className="text-[12px] font-bold text-green-700">重複は検出されませんでした。</p>
            ) : (
              <ul className="space-y-4">
                {audit.groups.map((group) => {
                  const result = mergeResults[group.sourceInventoryId];
                  return (
                    <li key={group.sourceInventoryId} className="border border-amber-300 bg-amber-50 p-3">
                      <p className="mb-2 text-[12px] font-bold text-gray-900">ZAICO在庫ID: {group.sourceInventoryId}({group.records.length}件が重複)</p>
                      <table className="mb-2 w-full text-[11px]">
                        <thead>
                          <tr className="text-left text-gray-500">
                            <th className="pb-1 pr-2">正規として残す</th>
                            <th className="pb-1 pr-2">内部ID</th>
                            <th className="pb-1 pr-2">SKU</th>
                            <th className="pb-1 pr-2">商品名</th>
                            <th className="pb-1">登録日時</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.records.map((r) => (
                            <tr key={r.id} className="border-t border-amber-200">
                              <td className="py-1 pr-2">
                                <input
                                  type="radio"
                                  name={`canonical-${group.sourceInventoryId}`}
                                  checked={(selectedCanonical[group.sourceInventoryId] ?? group.suggestedCanonicalId) === r.id}
                                  onChange={() => setSelectedCanonical((s) => ({ ...s, [group.sourceInventoryId]: r.id }))}
                                />
                              </td>
                              <td className="py-1 pr-2 font-mono">
                                {r.id}
                                {r.id === group.suggestedCanonicalId && <span className="ml-1 text-gray-500">(最古)</span>}
                              </td>
                              <td className="py-1 pr-2 font-mono">{r.sku}</td>
                              <td className="py-1 pr-2">{r.name}</td>
                              <td className="py-1">{r.createdAt}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <button
                        type="button"
                        onClick={() => handleMerge(group)}
                        disabled={mergingKey === group.sourceInventoryId}
                        className="bg-gray-900 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                      >
                        {mergingKey === group.sourceInventoryId ? "統合中…" : "選択したレコードへ統合する"}
                      </button>
                      {result && <p className={`mt-2 text-[11px] ${result.ok ? "text-green-700" : "text-red-600"}`}>{result.message}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
