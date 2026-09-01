"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteKnowledgeDocumentAction,
  getAIReplySettingsAction,
  listKnowledgeDocumentsAction,
  readKnowledgeContentAction,
  replaceKnowledgeDocumentAction,
  seedKnowledgeDocumentsAction,
  updateAIReplySettingsAction,
  updateKnowledgeMetadataAction,
  uploadKnowledgeDocumentAction,
} from "@/app/actions/knowledge";
import type { KnowledgeDocumentRecord } from "@/lib/knowledge/store";
import type { AIReplySettings } from "@/lib/inquiry/settings";
import { KNOWLEDGE_ALLOWED_EXTENSIONS, KNOWLEDGE_MAX_FILE_BYTES } from "@/lib/knowledge/limits";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { MarkdownPreview } from "./MarkdownPreview";

/**
 * §5/§42 設定 > AI返信ナレッジ。ADMIN専用。
 *
 * 【ダウンロードの経路】署名付きURLもS3のURLもブラウザへ渡さない。
 * Server Actionが中身を返し、ここでBlobを作ってダウンロードさせる
 * (§22「ダウンロードURLが恒久公開URLにならないようにする」を、
 * 「URLを一切作らない」という形で満たす)。
 *
 * 【AI返信設定を同じタブに置いた理由】§42はタブを2つに分けた図を
 * 示しているが、同時に「既存設定画面の構成を優先し、無理に新しいナビ
 * 構造を増やさない」とも書いている。この設定は3つのトグルだけで、
 * ナレッジ文書と同じ「AI返信の挙動」を決めるものなので、1タブに
 * まとめて上下に置く。
 */
export function KnowledgeSettingsPanel() {
  const [documents, setDocuments] = useState<KnowledgeDocumentRecord[]>([]);
  const [settings, setSettings] = useState<AIReplySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<"title" | "updatedAt" | "sizeBytes">("title");
  const [preview, setPreview] = useState<{ id: string; fileName: string; content: string } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [replaceTargetId, setReplaceTargetId] = useState<string | null>(null);
  // 編集は1文書ずつ。複数を同時に開けると、どれを保存しようとしているのか
  // 分からなくなる(そして競合検知のversionも取り違えやすい)。
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    // 初回だけ読み込む。以降は各操作の後に明示的にrefreshする。
  }, []);

  async function refresh() {
    setLoading(true);
    const [docsResult, settingsResult] = await Promise.all([listKnowledgeDocumentsAction(), getAIReplySettingsAction()]);
    if (docsResult.ok) setDocuments(docsResult.data);
    else setMessage({ kind: "error", text: docsResult.error });
    if (settingsResult.ok) setSettings(settingsResult.data);
    setLoading(false);
  }

  /**
   * ファイルをUTF-8のテキストとして読む。
   *
   * 【なぜUTF-8決め打ちか】Shift_JISのファイルを黙って読み替えると、
   * 文字化けした本文がそのまま検索用テキストとAI参照へ入る。検証側
   * (looksLikeText)が置換文字の多い内容を弾くので、UTF-8でない
   * ファイルは「テキストとして読めない」というはっきりした失敗になる。
   */
  function readAsUtf8(file: File): Promise<string> {
    return file.text();
  }

  async function handleUpload(file: File) {
    setBusy(true);
    setMessage(null);
    try {
      const content = await readAsUtf8(file);
      const result = await uploadKnowledgeDocumentAction({
        fileName: file.name,
        mimeType: file.type,
        content,
        title: file.name.replace(/\.(txt|md|markdown)$/i, ""),
        description: null,
        category: null,
      });
      if (!result.ok) setMessage({ kind: "error", text: result.error });
      else {
        setMessage({ kind: "success", text: `「${result.data.title}」を登録しました。` });
        await refresh();
      }
    } finally {
      setBusy(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  async function handleReplace(id: string, file: File) {
    setBusy(true);
    setMessage(null);
    try {
      const content = await readAsUtf8(file);
      const result = await replaceKnowledgeDocumentAction(id, { fileName: file.name, mimeType: file.type, content });
      if (!result.ok) setMessage({ kind: "error", text: result.error });
      else {
        setMessage({ kind: "success", text: `「${result.data.title}」を差し替えました(版 ${result.data.version})。` });
        setPreview(null);
        await refresh();
      }
    } finally {
      setBusy(false);
      setReplaceTargetId(null);
      if (replaceInputRef.current) replaceInputRef.current.value = "";
    }
  }

  async function handleDownload(doc: KnowledgeDocumentRecord) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await readKnowledgeContentAction(doc.id);
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      // charset=utf-8 を明示する。付けないと、日本語の文書を開いたときに
      // 環境の既定エンコーディングで解釈されて文字化けする。
      const blob = new Blob([result.data.content], { type: `${result.data.mimeType || "text/plain"};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.data.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview(doc: KnowledgeDocumentRecord) {
    if (preview?.id === doc.id) {
      setPreview(null);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await readKnowledgeContentAction(doc.id);
      if (!result.ok) setMessage({ kind: "error", text: result.error });
      else setPreview({ id: doc.id, fileName: result.data.fileName, content: result.data.content });
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(doc: KnowledgeDocumentRecord, patch: { isActive?: boolean; aiReferenceEnabled?: boolean }) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await updateKnowledgeMetadataAction(doc.id, patch);
      if (!result.ok) setMessage({ kind: "error", text: result.error });
      else setDocuments((prev) => prev.map((d) => (d.id === doc.id ? result.data : d)));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(doc: KnowledgeDocumentRecord) {
    if (!window.confirm(`ナレッジ文書「${doc.title}」を削除します。AI返信はこの文書を参照しなくなります。よろしいですか？`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await deleteKnowledgeDocumentAction(doc.id);
      if (!result.ok) setMessage({ kind: "error", text: result.error });
      else {
        setMessage({ kind: "success", text: `「${doc.title}」を削除しました。` });
        if (preview?.id === doc.id) setPreview(null);
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSeed() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await seedKnowledgeDocumentsAction();
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      const parts: string[] = [];
      if (result.data.created.length > 0) parts.push(`登録: ${result.data.created.join(" / ")}`);
      if (result.data.skipped.length > 0) parts.push(`既に登録済み: ${result.data.skipped.join(" / ")}`);
      if (result.data.failed.length > 0) parts.push(`失敗: ${result.data.failed.map((f) => `${f.title}(${f.reason})`).join(" / ")}`);
      setMessage({ kind: result.data.failed.length > 0 ? "error" : "success", text: parts.join(" 、 ") || "変更はありません。" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleSettingChange(patch: { autoDraftEnabled?: boolean; webResearchEnabled?: boolean; knowledgeEnabled?: boolean }) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await updateAIReplySettingsAction(patch);
      if (!result.ok) setMessage({ kind: "error", text: result.error });
      else setSettings(result.data);
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? documents.filter(
          (d) =>
            d.title.toLowerCase().includes(q) ||
            d.originalFileName.toLowerCase().includes(q) ||
            (d.description ?? "").toLowerCase().includes(q) ||
            (d.category ?? "").toLowerCase().includes(q) ||
            (d.searchText ?? "").toLowerCase().includes(q),
        )
      : documents;
    return [...filtered].sort((a, b) => {
      if (sortKey === "updatedAt") return b.updatedAt.localeCompare(a.updatedAt);
      if (sortKey === "sizeBytes") return b.sizeBytes - a.sizeBytes;
      return a.title.localeCompare(b.title, "ja");
    });
  }, [documents, query, sortKey]);

  return (
    <div className="space-y-6 py-4">
      <section>
        <h2 className="text-[13px] font-bold text-gray-900">AI返信ナレッジ</h2>
        <p className="mt-1 text-[12px] text-gray-500">
          問い合わせ返信のときにAIが参照する社内文書です。関連する文書の必要な箇所だけがAIへ渡されます（全文書を毎回渡すことはしません）。
          対応形式は {KNOWLEDGE_ALLOWED_EXTENSIONS.join(" / ")}、1ファイル {Math.floor(KNOWLEDGE_MAX_FILE_BYTES / 1024)}KB まで。
        </p>

        {message && (
          <p className={`mt-3 text-[12px] ${message.kind === "success" ? "text-green-700" : "text-red-600"}`}>{message.text}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            ref={uploadInputRef}
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
            className="text-[12px]"
          />
          <button type="button" onClick={handleSeed} disabled={busy} className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40">
            初期文書を登録
          </button>
        </div>
        <p className="mt-1 text-[11px] text-gray-400">
          「初期文書を登録」は、基本情報.txt と AI問い合わせ返信ルール.md を未登録の場合のみ追加します。既に登録済みの内容は上書きしません。
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="文書を検索（タイトル・説明・本文）"
            className="w-64 border border-gray-300 px-2 py-1 text-[12px]"
          />
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as typeof sortKey)} className="border border-gray-300 px-2 py-1 text-[12px]">
            <option value="title">タイトル順</option>
            <option value="updatedAt">更新が新しい順</option>
            <option value="sizeBytes">サイズが大きい順</option>
          </select>
        </div>

        {loading ? (
          <p className="mt-4 text-[12px] text-gray-500">読み込み中…</p>
        ) : visible.length === 0 ? (
          <p className="mt-4 text-[12px] text-gray-500">
            {documents.length === 0 ? "ナレッジ文書はまだ登録されていません。" : "検索条件に一致する文書がありません。"}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-200 border border-gray-200">
            {visible.map((doc) => (
              <li key={doc.id} className="p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold text-gray-900">{doc.title}</p>
                    <p className="text-[11px] text-gray-500">
                      {doc.originalFileName} ・ {formatBytes(doc.sizeBytes)} ・ 版 {doc.version} ・ 更新 {formatDateTime(doc.updatedAt)}
                      {doc.category ? ` ・ ${doc.category}` : ""}
                    </p>
                    {doc.description && <p className="mt-1 text-[12px] text-gray-600">{doc.description}</p>}
                    {doc.searchTextTruncated && (
                      <p className="mt-1 text-[11px] text-amber-600">
                        文書が大きいため、検索対象は先頭部分のみです（原本のダウンロードは全文が取得できます）。
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1 text-[11px] text-gray-600">
                      <input type="checkbox" checked={doc.isActive} disabled={busy} onChange={(e) => void handleToggle(doc, { isActive: e.target.checked })} />
                      有効
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-gray-600">
                      <input
                        type="checkbox"
                        checked={doc.aiReferenceEnabled}
                        disabled={busy}
                        onChange={(e) => void handleToggle(doc, { aiReferenceEnabled: e.target.checked })}
                      />
                      AI参照
                    </label>
                    <button type="button" onClick={() => void handlePreview(doc)} disabled={busy} className="border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                      {preview?.id === doc.id ? "閉じる" : "プレビュー"}
                    </button>
                    {/* 編集と削除は別のボタンに分ける(§削除操作と本文編集を分離)。 */}
                    <button
                      type="button"
                      onClick={() => setEditingId(editingId === doc.id ? null : doc.id)}
                      disabled={busy}
                      className="border border-gray-900 px-2 py-1 text-[11px] font-bold text-gray-900 hover:bg-gray-50 disabled:opacity-40"
                    >
                      {editingId === doc.id ? "編集を閉じる" : "編集"}
                    </button>
                    <button type="button" onClick={() => void handleDownload(doc)} disabled={busy} className="border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                      ダウンロード
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setReplaceTargetId(doc.id);
                        replaceInputRef.current?.click();
                      }}
                      disabled={busy}
                      className="border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                    >
                      差し替え
                    </button>
                    <button type="button" onClick={() => void handleDelete(doc)} disabled={busy} className="border border-red-300 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-40">
                      削除
                    </button>
                  </div>
                </div>
                {editingId === doc.id && (
                  <KnowledgeEditor doc={doc} onSaved={() => void refresh()} />
                )}
                {preview?.id === doc.id && (
                  <div className="mt-3 max-h-80 overflow-y-auto border border-gray-200 bg-gray-50 p-3">
                    <MarkdownPreview source={preview.content} plain={!/\.(md|markdown)$/i.test(preview.fileName)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <input
          ref={replaceInputRef}
          type="file"
          accept=".txt,.md,.markdown,text/plain,text/markdown"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && replaceTargetId) void handleReplace(replaceTargetId, file);
          }}
        />
      </section>

      <section className="border-t border-gray-200 pt-5">
        <h2 className="text-[13px] font-bold text-gray-900">AI返信設定</h2>
        {settings === null ? (
          <p className="mt-2 text-[12px] text-gray-500">読み込み中…</p>
        ) : (
          <div className="mt-2 space-y-2">
            <label className="flex items-center gap-2 text-[12px] text-gray-700">
              <input type="checkbox" checked={settings.autoDraftEnabled} disabled={busy} onChange={(e) => void handleSettingChange({ autoDraftEnabled: e.target.checked })} />
              返信案の生成を有効にする
            </label>
            <label className="flex items-center gap-2 text-[12px] text-gray-700">
              <input type="checkbox" checked={settings.webResearchEnabled} disabled={busy} onChange={(e) => void handleSettingChange({ webResearchEnabled: e.target.checked })} />
              在庫情報・社内文書で分からない項目に限り、外部の情報を参照する
            </label>
            <label className="flex items-center gap-2 text-[12px] text-gray-700">
              <input type="checkbox" checked={settings.knowledgeEnabled} disabled={busy} onChange={(e) => void handleSettingChange({ knowledgeEnabled: e.target.checked })} />
              ナレッジ文書を参照する
            </label>
            <div className="mt-3 border border-gray-200 bg-gray-50 p-3">
              <p className="text-[12px] font-bold text-gray-700">顧客への自動送信: 無効</p>
              <p className="mt-1 text-[11px] text-gray-500">
                AIが作るのは返信案までで、送信は必ず担当者が内容を確認してから行います。この画面から自動送信を有効にすることはできません。
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
