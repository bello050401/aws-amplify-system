"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteLineConnectionAction, setLineConnectionAction } from "@/app/actions/lineSecret";
import type { LineTokenSource } from "@/lib/messaging/line/tokenAccess";

/**
 * ADMIN専用のLINE接続設定パネル(BELLO統合業務OS指示書 2026-08-30
 * §51-52)。MercariSettingsPanel.tsxと同一のUIパターン
 * (Channel Secret/Access Tokenともこのコンポーネントの外(Server
 * Actionの戻り値)へは出ない)。
 */
export function LineSettingsPanel({ lineConnected, lineTokenSource }: { lineConnected: boolean; lineTokenSource: LineTokenSource }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [channelSecretInput, setChannelSecretInput] = useState("");
  const [accessTokenInput, setAccessTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const status: "未設定" | "接続済み" | "エラー" = message?.kind === "error" ? "エラー" : lineConnected ? "接続済み" : "未設定";
  const statusClass = status === "接続済み" ? "text-green-700" : status === "エラー" ? "text-amber-600" : "text-red-600";

  function startEditing() {
    setChannelSecretInput("");
    setAccessTokenInput("");
    setMessage(null);
    setEditing(true);
  }

  async function handleSave() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await setLineConnectionAction({ channelSecret: channelSecretInput, accessToken: accessTokenInput });
      setMessage({ kind: res.success ? "success" : "error", text: res.message });
      if (res.success) {
        setChannelSecretInput("");
        setAccessTokenInput("");
        setEditing(false);
        router.refresh();
      }
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "保存に失敗しました。" });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("LINE接続設定（Channel Secret・Channel Access Token）を削除します。削除するとLINEでのメッセージ受信・送信ができなくなります。よろしいですか？")) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await deleteLineConnectionAction();
      setMessage({ kind: res.success ? "success" : "error", text: res.message });
      if (res.success) router.refresh();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "削除に失敗しました。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-[12px] text-gray-500">
        LINE公式アカウントでのお問い合わせ受信・返信機能の接続設定です。設定すると、メッセージ画面でLINEからの会話を受信・返信できるようになります。
      </p>

      <div className="border border-gray-200 p-4">
        <p className="mb-1 text-[12px] font-bold text-gray-700">LINE接続設定</p>
        <p className="text-[13px]">
          <span className={`font-bold ${statusClass}`}>● {status}</span>
        </p>
        {lineTokenSource === "secrets-manager" && <p className="mt-1 text-[11px] text-green-700">取得経路: AWS Secrets Manager(SSR Compute Role経由)</p>}
        {lineTokenSource === "env-fallback" && (
          <p className="mt-1 text-[11px] text-amber-600">
            取得経路: サーバー環境変数フォールバック(LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN) — AWS Secrets Managerからは未取得です。
          </p>
        )}

        {!editing ? (
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={startEditing} className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50">
              {lineConnected ? "接続設定を変更" : "LINE接続設定を行う"}
            </button>
            {lineConnected && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="border border-red-200 px-3 py-1 text-[12px] text-red-500 hover:bg-red-50 disabled:opacity-40"
              >
                LINE設定を削除
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 border-t border-gray-100 pt-2">
            <label className="block text-[11px] text-gray-500">Channel Secret（LINE Developers Console → チャネル基本設定）</label>
            <input
              type="password"
              autoComplete="off"
              value={channelSecretInput}
              onChange={(e) => setChannelSecretInput(e.target.value)}
              disabled={busy}
              placeholder="Channel Secretを貼り付け"
              className="mt-0.5 w-72 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-50"
            />

            <label className="mt-2 block text-[11px] text-gray-500">Channel Access Token（長期）</label>
            <input
              type="password"
              autoComplete="off"
              value={accessTokenInput}
              onChange={(e) => setAccessTokenInput(e.target.value)}
              disabled={busy}
              placeholder="Channel Access Tokenを貼り付け"
              className="mt-0.5 w-72 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-50"
            />

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || !channelSecretInput.trim() || !accessTokenInput.trim()}
                className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {busy ? "確認中…" : "接続確認して保存"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setChannelSecretInput("");
                  setAccessTokenInput("");
                  setMessage(null);
                }}
                disabled={busy}
                className="border border-gray-300 px-3 py-1 text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
            <p className="mt-1 text-[10px] text-gray-400">
              保存前にLINE APIへ実際に接続確認します（Botの基本情報取得）。確認が取れたものだけが保存されます（失敗しても既存の設定は変更されません）。
            </p>
          </div>
        )}

        {message && <p className={`mt-2 text-[12px] ${message.kind === "success" ? "text-green-700" : "text-red-600"}`}>{message.text}</p>}

        <details className="mt-3 text-[11px] text-gray-400">
          <summary className="cursor-pointer">詳細（Webhook URLの登録について）</summary>
          <p className="mt-1">
            上記に加えて、LINE Developers ConsoleのWebhook URL欄に <code className="mx-1 bg-gray-100 px-1">https://（このアプリの公開URL）/api/line/webhook</code>{" "}
            を登録し、Webhookを有効にする必要があります。このアプリがAmplify
            Hostingへ実際にデプロイされ、公開URLが確定してから行ってください（現時点では未デプロイのため、この手順はまだ実施できません）。
          </p>
        </details>
      </div>
    </div>
  );
}
