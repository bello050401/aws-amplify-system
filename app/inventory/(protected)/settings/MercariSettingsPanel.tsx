"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteMercariTokenAction, setMercariTokenAction } from "@/app/actions/mercariSecret";
import type { MercariTokenSource } from "@/lib/listing/mercari/tokenAccess";

/**
 * ADMIN専用のMercari Shops接続設定パネル(BELLO統合改修 master指示書
 * Phase D)。app/inventory/(protected)/settings/ZaicoSyncPanel.tsxの
 * 「ZAICO API接続設定」セクションと同一のUIパターン(TOKEN文字列は
 * 一度もこのコンポーネントの外(Server Actionの戻り値)へは出ない)。
 */
export function MercariSettingsPanel({
  mercariConnected,
  mercariTokenSource,
  mercariEnvironment,
  mercariApiClientNameConfigured,
}: {
  mercariConnected: boolean;
  mercariTokenSource: MercariTokenSource;
  mercariEnvironment: "sandbox" | "production";
  mercariApiClientNameConfigured: boolean;
}) {
  const router = useRouter();
  const [tokenEditing, setTokenEditing] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMessage, setTokenMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function handleSaveToken() {
    if (!tokenInput.trim()) return;
    setTokenBusy(true);
    setTokenMessage(null);
    try {
      const res = await setMercariTokenAction(tokenInput);
      setTokenMessage({ kind: res.success ? "success" : "error", text: res.message });
      if (res.success) {
        setTokenInput("");
        setTokenEditing(false);
        router.refresh();
      }
    } catch (err) {
      setTokenMessage({ kind: "error", text: err instanceof Error ? err.message : "保存に失敗しました。" });
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleDeleteToken() {
    if (!window.confirm("Mercari Shops API TOKENを削除します。削除するとEC出品機能が使用できなくなります。よろしいですか？")) return;
    setTokenBusy(true);
    setTokenMessage(null);
    try {
      const res = await deleteMercariTokenAction();
      setTokenMessage({ kind: res.success ? "success" : "error", text: res.message });
      if (res.success) router.refresh();
    } catch (err) {
      setTokenMessage({ kind: "error", text: err instanceof Error ? err.message : "削除に失敗しました。" });
    } finally {
      setTokenBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-[12px] text-gray-500">
        在庫の商品をMercari Shopsへ出品する機能の接続設定です。TOKENを設定すると、在庫詳細画面から「EC出品」を開いて出品下書きの作成・Mercariへの出品ができるようになります。
      </p>

      <div className="border border-gray-200 p-4">
        <p className="mb-1 text-[12px] font-bold text-gray-700">Mercari Shops API接続設定</p>
        <p className="text-[13px]">
          {mercariConnected ? (
            <span className="font-bold text-green-700">● 接続済み（{mercariEnvironment === "production" ? "本番" : "テスト環境（sandbox）"}）</span>
          ) : (
            <span className="font-bold text-red-600">● 未設定</span>
          )}
        </p>
        {mercariTokenSource === "secrets-manager" && (
          <p className="mt-1 text-[11px] text-green-700">取得経路: AWS Secrets Manager(SSR Compute Role経由)</p>
        )}
        {mercariTokenSource === "env-fallback" && (
          <p className="mt-1 text-[11px] text-amber-600">
            取得経路: サーバー環境変数フォールバック(MERCARI_ACCESS_TOKEN) — AWS Secrets Managerからは未取得です。SSR Compute
            Roleの設定を確認してください。
          </p>
        )}

        {!tokenEditing ? (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setTokenEditing(true);
                setTokenMessage(null);
              }}
              className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50"
            >
              {mercariConnected ? "API TOKENを変更" : "Mercari API TOKENを設定"}
            </button>
            {mercariConnected && (
              <button
                type="button"
                onClick={handleDeleteToken}
                disabled={tokenBusy}
                className="border border-red-200 px-3 py-1 text-[12px] text-red-500 hover:bg-red-50 disabled:opacity-40"
              >
                Mercari API設定を削除
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 border-t border-gray-100 pt-2">
            <label className="block text-[11px] text-gray-500">Mercari Shops Personal API Access Token</label>
            <div className="mt-0.5 flex gap-2">
              <input
                type="password"
                autoComplete="off"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                disabled={tokenBusy}
                placeholder="TOKENを貼り付け"
                className="w-72 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleSaveToken}
                disabled={tokenBusy || !tokenInput.trim()}
                className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {tokenBusy ? "確認中…" : "保存する"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTokenEditing(false);
                  setTokenInput("");
                  setTokenMessage(null);
                }}
                disabled={tokenBusy}
                className="border border-gray-300 px-3 py-1 text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
            <p className="mt-1 text-[10px] text-gray-400">保存前にMercari Shops APIへ接続確認します。確認が取れたものだけが保存されます。</p>
          </div>
        )}

        {tokenMessage && (
          <p className={`mt-2 text-[12px] ${tokenMessage.kind === "success" ? "text-green-700" : "text-red-600"}`}>{tokenMessage.text}</p>
        )}

        {!mercariConnected && !tokenEditing && (
          <p className="mt-1 text-[11px] text-gray-500">
            上のボタンから設定するか、サーバー環境変数 MERCARI_ACCESS_TOKEN で設定できます。環境(sandbox/production)はサーバー環境変数
            MERCARI_ENV で切り替えます(既定: sandbox)。
          </p>
        )}
      </div>

      {/* BELLO統合改修 master指示書(2026-08-29統合改修版) §7/§17:
          実際に報告されたHTTP 404の根本原因調査で判明した、Mercari公式
          ドキュメントが必須とするUser-Agentヘッダ用の設定
          (lib/listing/mercari/endpoints.tsのgetMercariUserAgent参照)。
          TOKENと違い認証情報そのものではないため値を隠す必要はないが、
          値自体はサーバー環境変数からしか設定できない(Mercariとの契約
          時に個社へ割り当てられる値で、この画面から入力・保存する対象
          ではない)ため、ここでは「設定済みかどうか」だけを表示する。 */}
      <div className="mt-3 border border-gray-200 p-4">
        <p className="mb-1 text-[12px] font-bold text-gray-700">API接続用User-Agent設定</p>
        <p className="mb-2 text-[11px] text-gray-500">
          Mercari
          Shops公式ドキュメントは、すべてのリクエストへ正しいUser-Agent（契約時にMercariから割り当てられるAPIクライアント名を含む）を設定することを必須としています。未設定のまま出品を試みると、原因が分かりにくいエラー（HTTP
          404を含む）になることがあります。
        </p>
        <p className="text-[13px]">
          {mercariApiClientNameConfigured ? (
            <span className="font-bold text-green-700">● 設定済み</span>
          ) : (
            <span className="font-bold text-red-600">● 未設定</span>
          )}
        </p>
        {!mercariApiClientNameConfigured && (
          <p className="mt-1 text-[11px] text-gray-500">
            サーバー環境変数 <code className="mx-1 bg-gray-100 px-1">MERCARI_API_CLIENT_NAME</code>
            にMercari Shopsとの契約時に割り当てられたAPIクライアント名を設定してください（値についてはMercari
            Shopsの契約担当窓口へご確認ください。この画面から捏造した値を設定しても解決しません）。バージョン文字列は任意で
            <code className="mx-1 bg-gray-100 px-1">MERCARI_API_CLIENT_VERSION</code>
            （未設定時は既定値 0.0.0）で指定できます。
          </p>
        )}
      </div>
    </div>
  );
}
