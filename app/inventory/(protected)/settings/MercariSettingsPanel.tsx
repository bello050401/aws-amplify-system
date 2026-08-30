"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteMercariTokenAction, setMercariConnectionAction } from "@/app/actions/mercariSecret";
import type { MercariTokenSource } from "@/lib/listing/mercari/tokenAccess";

/**
 * ADMIN専用のMercari Shops接続設定パネル(BELLO統合業務OS指示書
 * 2026-08-30 §24)。以前はTOKENとAPIクライアント名(User-Agent用)が別々
 * のセクションで、しかもクライアント名はサーバー環境変数からしか設定
 * できなかった(§24が名指しした「現在の問題」) — この2つを1つの
 * 「Mercari Shops API接続設定」フォームへ統合し、どちらもこの画面から
 * 入力・検証・保存できるようにした。
 *
 * app/inventory/(protected)/settings/ZaicoSyncPanel.tsxの「ZAICO
 * API接続設定」セクションと同一のUIパターン(TOKEN文字列は一度も
 * このコンポーネントの外(Server Actionの戻り値)へは出ない)。
 * APIクライアント名はTOKENと違い秘匿情報そのものではないため、保存済み
 * の値自体は表示して構わない(§26: 「Client
 * Nameもserver-side config」であって、TOKENのような「二度と表示しな
 * い」対象ではない)。
 */
export function MercariSettingsPanel({
  mercariConnected,
  mercariTokenSource,
  mercariEnvironment,
  mercariClientName,
  mercariClientNameSource,
}: {
  mercariConnected: boolean;
  mercariTokenSource: MercariTokenSource;
  mercariEnvironment: "sandbox" | "production";
  /** 保存済みのAPIクライアント名(secrets-manager/env-fallabckどちらか、無ければnull) — TOKENと違い秘匿値ではないので、そのまま表示してよい。 */
  mercariClientName: string | null;
  mercariClientNameSource: MercariTokenSource;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [clientNameInput, setClientNameInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  // 状態: 未設定 / 接続済み / エラー(§24の3状態) — 「エラー」は直近の
  // 保存操作が失敗した場合の一時的な表示で、保存済みの既存設定自体は
  // §92により壊れていない(失敗してもmercariConnectedはそのまま)。
  const status: "未設定" | "接続済み" | "エラー" = message?.kind === "error" ? "エラー" : mercariConnected ? "接続済み" : "未設定";
  const statusClass = status === "接続済み" ? "text-green-700" : status === "エラー" ? "text-amber-600" : "text-red-600";

  function startEditing() {
    setClientNameInput(mercariClientName ?? "");
    setTokenInput("");
    setMessage(null);
    setEditing(true);
  }

  async function handleSave() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await setMercariConnectionAction({ token: tokenInput, clientName: clientNameInput });
      setMessage({ kind: res.success ? "success" : "error", text: res.message });
      if (res.success) {
        setTokenInput("");
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
    if (!window.confirm("Mercari Shops API接続設定（APIクライアント名・TOKEN）を削除します。削除するとEC出品機能が使用できなくなります。よろしいですか？")) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await deleteMercariTokenAction();
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
        在庫の商品をMercari Shopsへ出品する機能の接続設定です。設定すると、在庫詳細画面から「EC出品」を開いて出品下書きの作成・Mercariへの出品ができるようになります。
      </p>

      <div className="border border-gray-200 p-4">
        <p className="mb-1 text-[12px] font-bold text-gray-700">Mercari Shops API接続設定</p>
        <p className="text-[13px]">
          <span className={`font-bold ${statusClass}`}>
            ● {status}
            {status === "接続済み" && `（${mercariEnvironment === "production" ? "本番" : "テスト環境（sandbox）"}）`}
          </span>
        </p>
        {mercariTokenSource === "secrets-manager" && (
          <p className="mt-1 text-[11px] text-green-700">TOKEN取得経路: AWS Secrets Manager(SSR Compute Role経由)</p>
        )}
        {mercariTokenSource === "env-fallback" && (
          <p className="mt-1 text-[11px] text-amber-600">
            TOKEN取得経路: サーバー環境変数フォールバック(MERCARI_ACCESS_TOKEN) — AWS Secrets Managerからは未取得です。
          </p>
        )}
        {mercariClientName && (
          <p className="mt-1 text-[11px] text-gray-500">
            APIクライアント名: <span className="font-mono text-gray-700">{mercariClientName}</span>
            {mercariClientNameSource === "env-fallback" && "（サーバー環境変数から取得）"}
          </p>
        )}

        {!editing ? (
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={startEditing} className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50">
              {mercariConnected ? "接続設定を変更" : "Mercari API接続設定を行う"}
            </button>
            {mercariConnected && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="border border-red-200 px-3 py-1 text-[12px] text-red-500 hover:bg-red-50 disabled:opacity-40"
              >
                Mercari API設定を削除
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 border-t border-gray-100 pt-2">
            <label className="block text-[11px] text-gray-500">
              APIクライアント名
              <span className="ml-1 text-gray-400">（Mercari Shopsとの契約時に割り当てられた値）</span>
            </label>
            <input
              value={clientNameInput}
              onChange={(e) => setClientNameInput(e.target.value)}
              disabled={busy}
              placeholder="例: bello-inventory"
              className="mt-0.5 w-72 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-50"
            />

            <label className="mt-2 block text-[11px] text-gray-500">Personal API Access Token</label>
            <input
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              disabled={busy}
              placeholder="TOKENを貼り付け"
              className="mt-0.5 w-72 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-50"
            />

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || !clientNameInput.trim() || !tokenInput.trim()}
                className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {busy ? "確認中…" : "接続確認して保存"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setTokenInput("");
                  setMessage(null);
                }}
                disabled={busy}
                className="border border-gray-300 px-3 py-1 text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
            <p className="mt-1 text-[10px] text-gray-400">
              保存前にMercari Shops APIへ実際に接続確認します。確認が取れたものだけが保存されます（失敗しても既存の設定は変更されません）。
            </p>
          </div>
        )}

        {message && <p className={`mt-2 text-[12px] ${message.kind === "success" ? "text-green-700" : "text-red-600"}`}>{message.text}</p>}

        {!mercariConnected && !editing && (
          <p className="mt-1 text-[11px] text-gray-500">
            上のボタンから設定するか、サーバー環境変数 MERCARI_ACCESS_TOKEN / MERCARI_API_CLIENT_NAME で設定できます。環境(sandbox/production)はサーバー環境変数
            MERCARI_ENV で切り替えます(既定: sandbox)。
          </p>
        )}

        {/* BELLO統合業務OS指示書(2026-08-30) §90: 技術的な長文説明を通常
            画面へ常時表示しない。必要なら「詳細」— User-Agentヘッダの
            背景説明はここへ折りたたむ。 */}
        <details className="mt-3 text-[11px] text-gray-400">
          <summary className="cursor-pointer">詳細（User-Agentヘッダについて）</summary>
          <p className="mt-1">
            Mercari Shops公式ドキュメントは、すべてのリクエストへ正しいUser-Agent（上記のAPIクライアント名を含む）を設定することを必須としています。未設定のまま出品を試みると、原因が分かりにくいエラー（HTTP
            404を含む）になることがあります。バージョン文字列は任意で環境変数
            <code className="mx-1 bg-gray-100 px-1">MERCARI_API_CLIENT_VERSION</code>
            （未設定時は既定値 0.0.0）から指定できます。
          </p>
        </details>
      </div>
    </div>
  );
}
