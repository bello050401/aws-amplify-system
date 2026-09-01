"use client";

import { useEffect, useState } from "react";
import {
  listKnowledgeRevisionsAction,
  readKnowledgeContentAction,
  restoreKnowledgeRevisionAction,
  saveKnowledgeBodyAction,
} from "@/app/actions/knowledge";
import type { KnowledgeDocumentRecord } from "@/lib/knowledge/store";
import type { KnowledgeRevisionRecord } from "@/lib/knowledge/revisions";
import { MarkdownPreview } from "./MarkdownPreview";

/**
 * ナレッジ文書をその場で編集する。
 *
 * ## 保存前に必ず差分を見せる
 *
 * 要件が「保存前に変更内容を確認できる」。編集して即保存にすると、
 * 貼り付けミスや消しすぎにその場で気づけない。保存ボタンは
 * 「確認する」→「この内容で保存する」の2段にしてある。
 *
 * ## 復元も同じ形
 *
 * 「1つ前に戻す」も、押した瞬間に上書きせず、対象の版の中身を見せてから
 * 実行する。復元自体も新しい変更として履歴に積まれるので、戻しすぎても
 * また戻せる。
 *
 * ## 競合検知
 *
 * 編集を始めた時点の version を保持し、保存時にサーバーへ渡す。別の人が
 * 先に保存していれば、こちらの内容では上書きせずに知らせる。
 */
export function KnowledgeEditor({ doc, onSaved }: { doc: KnowledgeDocumentRecord; onSaved: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [baseVersion, setBaseVersion] = useState<number>(doc.version);
  const [revisions, setRevisions] = useState<KnowledgeRevisionRecord[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<KnowledgeRevisionRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      const [content, revs] = await Promise.all([readKnowledgeContentAction(doc.id), listKnowledgeRevisionsAction(doc.id)]);
      if (cancelled) return;
      if (content.ok) {
        setBody(content.data.content);
        setOriginal(content.data.content);
        setBaseVersion(doc.version);
      } else {
        setError(content.error);
      }
      if (revs.ok) setRevisions(revs.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.id, doc.version]);

  const changed = body !== null && body !== original;

  async function reloadRevisions() {
    const revs = await listKnowledgeRevisionsAction(doc.id);
    if (revs.ok) setRevisions(revs.data);
  }

  async function handleSave() {
    if (body === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveKnowledgeBodyAction({ documentId: doc.id, body, expectedVersion: baseVersion });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOriginal(body);
      setBaseVersion(result.data.version);
      setConfirming(false);
      setNotice(`保存しました（v${result.data.version}）。`);
      await reloadRevisions();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!restoreTarget) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await restoreKnowledgeRevisionAction({
        documentId: doc.id,
        revisionId: restoreTarget.id,
        expectedVersion: baseVersion,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody(restoreTarget.body ?? "");
      setOriginal(restoreTarget.body ?? "");
      setBaseVersion(result.data.version);
      setRestoreTarget(null);
      setNotice(`v${restoreTarget.version} の内容へ復元しました（新しい版 v${result.data.version} として保存されています）。`);
      await reloadRevisions();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "復元に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  if (body === null) {
    return <p className="mt-3 text-[12px] text-gray-400">{error ?? "本文を読み込んでいます…"}</p>;
  }

  return (
    <div className="mt-3 border border-gray-200 bg-white p-3">
      {notice && <p className="mb-2 border border-green-300 bg-green-50 p-2 text-[12px] text-green-800">{notice}</p>}
      {error && <p className="mb-2 border border-red-300 bg-red-50 p-2 text-[12px] text-red-700">{error}</p>}

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-gray-500">
          現在 v{baseVersion}
          {doc.updatedBy ? ` ・ 最終更新者 ${doc.updatedBy}` : ""}
          {doc.updatedAt ? ` ・ ${new Date(doc.updatedAt).toLocaleString("ja-JP")}` : ""}
        </p>
        {changed && <span className="text-[11px] text-amber-600">未保存の変更があります</span>}
      </div>

      {!confirming ? (
        <>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            rows={18}
            className="w-full border border-gray-300 p-2 font-mono text-[12px]"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy || !changed}
              className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-40"
            >
              変更内容を確認する
            </button>
            <button
              type="button"
              onClick={() => setBody(original)}
              disabled={busy || !changed}
              className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              編集を破棄
            </button>
          </div>
        </>
      ) : (
        <div>
          <p className="mb-2 text-[12px] font-bold text-gray-700">この内容で保存します。よろしいですか？</p>
          <div className="max-h-72 overflow-y-auto border border-gray-200 bg-gray-50 p-3">
            <MarkdownPreview source={body} plain={!/\.(md|markdown)$/i.test(doc.originalFileName)} />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy}
              className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-40"
            >
              {busy ? "保存中…" : "この内容で保存する"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50"
            >
              編集へ戻る
            </button>
          </div>
        </div>
      )}

      {/* 履歴。現在版に加えて直近2世代まで。 */}
      <div className="mt-4 border-t border-gray-200 pt-3">
        <p className="mb-1 text-[11px] font-bold text-gray-600">変更履歴（現在版＋直近2世代）</p>
        {revisions.length === 0 ? (
          <p className="text-[11px] text-gray-400">まだ履歴がありません（この画面から保存すると記録されます）。</p>
        ) : (
          <ul className="space-y-1">
            {revisions.map((rev, index) => (
              <li key={rev.id} className="flex flex-wrap items-center gap-2 text-[11px] text-gray-600">
                <span className="rounded bg-gray-100 px-1">{index === 0 ? "1つ前" : index === 1 ? "2つ前" : `${index + 1}つ前`}</span>
                <span>v{rev.version}</span>
                <span>{rev.changedAt ? new Date(rev.changedAt).toLocaleString("ja-JP") : ""}</span>
                {rev.changedBy && <span>{rev.changedBy}</span>}
                {rev.changeType === "RESTORE" && (
                  <span className="text-gray-400">（v{rev.restoredFromVersion} からの復元）</span>
                )}
                <button
                  type="button"
                  onClick={() => setRestoreTarget(rev)}
                  disabled={busy || rev.body === null}
                  className="border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  この版を見る
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* 復元は「見てから」。押した瞬間には上書きしない。 */}
        {restoreTarget && (
          <div className="mt-2 border border-amber-300 bg-amber-50 p-2">
            <p className="mb-1 text-[12px] font-bold text-amber-900">v{restoreTarget.version} の内容</p>
            <div className="max-h-60 overflow-y-auto border border-amber-200 bg-white p-2">
              <MarkdownPreview source={restoreTarget.body ?? ""} plain={!/\.(md|markdown)$/i.test(doc.originalFileName)} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleRestore()}
                disabled={busy}
                className="bg-amber-700 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-40"
              >
                {busy ? "復元中…" : "この内容へ復元する"}
              </button>
              <button
                type="button"
                onClick={() => setRestoreTarget(null)}
                disabled={busy}
                className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-white"
              >
                やめる
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
