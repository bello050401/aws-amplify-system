"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { BaseConnectionState } from "@/lib/base/connectionState";
import {
  deleteBaseCredentialsAction,
  saveBaseCredentialsAction,
  testBaseConnectionAction,
  type BaseConnectionTestResult,
} from "@/app/actions/baseSecret";

/**
 * ADMIN専用のBASE API接続設定パネル。
 *
 * ## この画面で接続を完了できるようにした理由
 *
 * 以前このパネルは状態を表示するだけで、`BASE_CLIENT_ID` /
 * `BASE_CLIENT_SECRET` / `BASE_REDIRECT_URI` を設定する手段は
 * 「AWSの環境変数を編集して再デプロイする」しかなかった。
 * 結果としてStagingではBASEが一度も接続されず、BASE連携機能
 * (特集ページ作成・商品説明分析)がどちらも動かせない状態だった。
 *
 * ## 秘密値の扱い(要件そのもの)
 *
 * - Client Secretは入力後サーバーへ渡すだけで、**保存後は二度と平文で
 *   表示しない**(サーバー側が返さない設計 —— lib/base/secretStore.ts)。
 * - ブラウザ側DB・localStorage・公開環境変数(`NEXT_PUBLIC_`)には置かない。
 * - 実際にAWS Secrets Managerを書くのはSSRの実行ロールで、
 *   ブラウザはAWSの権限を一切持たない(app/actions/baseSecret.ts参照)。
 *
 * ## コールバックURL
 *
 * 手で3か所(BASE Developers・認可URL・トークン交換)を揃えさせない。
 * サーバーが自分のURLから組み立てた値を表示し、コピーできるようにする
 * (lib/base/redirectUri.ts)。ここが1文字違うだけで
 * `redirect_uri_mismatch` になり、原因が最も分かりにくい種類の失敗になる。
 */
export function BaseSettingsPanel({ state }: { state: BaseConnectionState }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [requestWriteItems, setRequestWriteItems] = useState(state.requestWriteItems);
  const [showForm, setShowForm] = useState(!state.hasAppCredentials);
  const [busy, setBusy] = useState<"save" | "delete" | "test" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<BaseConnectionTestResult | null>(null);
  const [copied, setCopied] = useState(false);

  // OAuthのcallbackはリダイレクトで戻ってくるので、結果はクエリで届く。
  // 一度読んだらURLから消す —— 再読み込みで古い結果が復活しないように。
  useEffect(() => {
    const connected = searchParams.get("baseConnected");
    const failed = searchParams.get("baseError");
    if (!connected && !failed) return;
    if (connected) setNotice("BASEアカウントとの連携が完了しました。下の「接続テスト」で商品を取得できるか確認してください。");
    if (failed) setError(failed);
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    next.delete("baseConnected");
    next.delete("baseError");
    const query = next.toString();
    router.replace(query ? `/inventory/settings?${query}` : "/inventory/settings", { scroll: false });
  }, [searchParams, router]);

  const label =
    state.status === "CONNECTED"
      ? "接続済み"
      : state.status === "CREDENTIALS_ONLY"
        ? "アプリ認証情報：設定済み（BASEアカウント未連携）"
        : state.status === "MOCK"
          ? "モックデータ使用中（開発用）"
          : "未設定";

  const labelClass =
    state.status === "CONNECTED" ? "text-green-700" : state.status === "NOT_CONFIGURED" ? "text-red-600" : "text-amber-600";

  async function handleSave() {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError("Client IDとClient Secretの両方を入力してください。");
      return;
    }
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const result = await saveBaseCredentialsAction({ clientId, clientSecret, requestWriteItems });
      if (!result.success) {
        setError(result.message);
        return;
      }
      // 入力欄からは即座に消す。画面上にSecretを残さない。
      setClientId("");
      setClientSecret("");
      setShowForm(false);
      setNotice(result.message);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!window.confirm("BASEのアプリ認証情報とアカウント連携を削除します。よろしいですか？")) return;
    setBusy("delete");
    setError(null);
    setNotice(null);
    try {
      const result = await deleteBaseCredentialsAction();
      if (!result.success) {
        setError(result.message);
        return;
      }
      setTestResult(null);
      setShowForm(true);
      setNotice(result.message);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy("test");
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      setTestResult(await testBaseConnectionAction());
    } catch (err) {
      setError(err instanceof Error ? err.message : "接続テストに失敗しました。");
    } finally {
      setBusy(null);
    }
  }

  async function handleCopyRedirectUri() {
    if (!state.redirectUri) return;
    try {
      await navigator.clipboard.writeText(state.redirectUri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境でも、値自体は画面に出ているので選択してコピーできる。
      setError("自動コピーできませんでした。表示されているURLを手動で選択してコピーしてください。");
    }
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-[12px] text-gray-500">
        BASEの商品情報を読み取るための接続設定です。特集ページ作成機能と商品説明分析機能は、この同じ接続を共用します（BELLOがBASE用の認証情報を二重に持つことはありません）。
      </p>

      {notice && <p className="mb-3 border border-green-300 bg-green-50 p-2 text-[12px] text-green-800">{notice}</p>}
      {error && <p className="mb-3 border border-red-300 bg-red-50 p-2 text-[12px] text-red-700">{error}</p>}

      <div className="border border-gray-200 p-4">
        <p className="mb-1 text-[12px] font-bold text-gray-700">BASE API</p>
        <p className="text-[13px]">
          <span className={`font-bold ${labelClass}`}>● {label}</span>
        </p>
        <p className="mt-1 text-[11px] text-gray-500">{state.message}</p>
        {state.checkError && <p className="mt-1 text-[11px] text-amber-600">{state.checkError}</p>}

        <div className="mt-3 space-y-1 text-[11px] text-gray-500">
          <p>
            アプリ認証情報（Client ID / Secret）:{" "}
            <span className={state.hasAppCredentials ? "text-green-700" : "text-red-600"}>
              {state.hasAppCredentials ? "設定済み" : "未設定"}
            </span>
            {state.hasAppCredentials && state.credentialsSource === "env-fallback" && (
              <span className="ml-1 text-amber-600">（AWS環境変数で設定されています）</span>
            )}
          </p>
          {/* Client IDは秘匿値ではない。設定済みの中身を確認できると、
              「別のアプリのIDを入れてしまった」に気付ける。Secretは出さない。 */}
          {state.clientId && (
            <p>
              登録済みClient ID: <code className="bg-gray-100 px-1">{state.clientId}</code>
            </p>
          )}
          {state.credentialsUpdatedAt && (
            <p>
              最終更新: {new Date(state.credentialsUpdatedAt).toLocaleString("ja-JP")}
              {state.credentialsUpdatedBy ? `（${state.credentialsUpdatedBy}）` : ""}
            </p>
          )}
          <p>
            BASEアカウント連携（OAuth）:{" "}
            <span className={state.hasOAuthToken ? "text-green-700" : "text-red-600"}>
              {state.hasOAuthToken ? "連携済み（トークンはサーバー側に保存）" : "未連携"}
            </span>
          </p>
          <p>
            要求する権限:{" "}
            <span className="text-gray-700">
              {state.requestWriteItems ? "商品情報の閲覧 + 編集（read_items / write_items）" : "商品情報の閲覧のみ（read_items）"}
            </span>
          </p>
          {/* 表示は必ず dataSource から導く。usingRealApi の2値だと、
              本番で認証情報が無い場合(実際にはモックへ落ちず失敗する)まで
              「モックデータを使用中」と表示してしまう。 */}
          <p>
            商品データの取得元:{" "}
            <span
              className={state.dataSource === "REAL" ? "text-green-700" : state.dataSource === "MOCK" ? "text-amber-600" : "text-red-600"}
            >
              {state.dataSource === "REAL"
                ? "BASEの実データ"
                : state.dataSource === "MOCK"
                  ? "開発用のモックデータ（実在しない商品）"
                  : "取得できません（接続が完了するまでBASEの商品は表示されません）"}
            </span>
          </p>
        </div>

        {/* --- BASE Developersへ登録する値 --- */}
        <div className="mt-4 border-t border-gray-200 pt-3">
          <p className="text-[12px] font-bold text-gray-700">① BASE Developersへ登録するコールバックURL</p>
          <p className="mt-1 text-[11px] text-gray-500">
            <a
              href="https://developers.thebase.in/"
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-600 underline"
            >
              BASE Developers
            </a>
            のアプリ設定にある「コールバックURL」へ、下の値を<strong>そのまま</strong>登録してください。1文字でも異なると認可画面がエラーになります。
          </p>
          {state.redirectUri ? (
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap bg-gray-100 px-2 py-1 text-[11px]">{state.redirectUri}</code>
              <button
                type="button"
                onClick={handleCopyRedirectUri}
                className="shrink-0 border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50"
              >
                {copied ? "コピーしました" : "コピー"}
              </button>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-amber-600">コールバックURLを組み立てられませんでした。ページを再読み込みしてください。</p>
          )}
        </div>

        {/* --- 認証情報の入力 --- */}
        <div className="mt-4 border-t border-gray-200 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-bold text-gray-700">② アプリ認証情報（Client ID / Client Secret）</p>
            {state.hasAppCredentials && !showForm && (
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50"
              >
                BASE API設定
              </button>
            )}
          </div>

          {showForm ? (
            <div className="mt-2 space-y-2">
              <p className="text-[11px] text-gray-500">
                BASE Developersのアプリ詳細に表示されている値を貼り付けてください。Client
                Secretは保存後、画面には二度と表示されません（サーバー側のAWS Secrets Managerにのみ保存されます）。
              </p>
              <label className="block text-[11px] text-gray-600">
                Client ID
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-1 w-full border border-gray-300 px-2 py-1 text-[12px]"
                  placeholder={state.clientId ? "変更する場合のみ入力（現在の値は上に表示）" : ""}
                />
              </label>
              <label className="block text-[11px] text-gray-600">
                Client Secret
                {/* type=password + autoComplete=off: ブラウザのパスワード保管へ
                    勝手に入らないようにする。値はstateにのみ一時的に存在し、
                    保存が成功した時点で消す。 */}
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-1 w-full border border-gray-300 px-2 py-1 text-[12px]"
                />
              </label>
              <label className="flex items-start gap-2 text-[11px] text-gray-600">
                <input
                  type="checkbox"
                  checked={requestWriteItems}
                  onChange={(e) => setRequestWriteItems(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  商品の編集権限（write_items）も要求する
                  <br />
                  <span className="text-gray-400">
                    BELLOからBASEへ出品・価格変更する機能に必要です。BASE
                    Developers側のアプリに「商品情報の編集」を許可していない場合は、
                    <strong>チェックを外してください</strong>
                    （許可されていない権限を要求すると認可自体が通らず、読み取りもできなくなります）。
                  </span>
                </span>
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={busy !== null}
                  className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
                >
                  {busy === "save" ? "保存中…" : "保存する"}
                </button>
                {state.hasAppCredentials && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowForm(false);
                      setClientId("");
                      setClientSecret("");
                    }}
                    className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50"
                  >
                    キャンセル
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-green-700">✓ アプリ認証情報：設定済み</p>
          )}
        </div>

        {/* --- OAuth連携 --- */}
        {state.hasAppCredentials && (
          <div className="mt-4 border-t border-gray-200 pt-3">
            <p className="text-[12px] font-bold text-gray-700">③ BASEアカウントとの連携</p>
            {state.hasOAuthToken ? (
              <p className="mt-2 text-[12px] text-green-700">✓ BASEアカウント連携：連携済み</p>
            ) : (
              <p className="mt-1 text-[11px] text-gray-500">
                下のボタンでBASEの認可画面が開きます。BASEアカウントの所有者本人がアクセスを許可する必要があります。
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {/* Server Actionではなく通常のリンク。OAuthはブラウザ自体を
                  BASEのドメインへ遷移させる必要があり、fetchでは成立しない。 */}
              <a
                href="/api/base/oauth/start"
                className="inline-block bg-gray-900 px-3 py-1 text-[12px] font-bold text-white hover:bg-gray-700"
              >
                {state.hasOAuthToken ? "BASEアカウントを再連携する" : "BASEアカウントを連携する"}
              </a>
              <button
                type="button"
                onClick={handleTest}
                disabled={busy !== null}
                className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === "test" ? "確認中…" : "接続テスト（商品を取得してみる）"}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy !== null}
                className="border border-red-300 px-3 py-1 text-[12px] text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {busy === "delete" ? "削除中…" : "設定を削除"}
              </button>
            </div>

            {/* 接続テストの結果。「保存できた」ではなく「実際に商品を取れた」
                ことを示すため、取得できた商品名まで出す。 */}
            {testResult && (
              <div
                className={`mt-3 border p-2 text-[11px] ${
                  testResult.success ? "border-green-300 bg-green-50 text-green-800" : "border-red-300 bg-red-50 text-red-700"
                }`}
              >
                <p className="font-bold">{testResult.message}</p>
                {testResult.success && testResult.sampleTitles.length > 0 && (
                  <ul className="mt-1 list-disc pl-4">
                    {testResult.sampleTitles.map((title, i) => (
                      <li key={i}>{title}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
