import type { BaseConnectionState } from "@/lib/base/connectionState";

/**
 * ADMIN専用のBASE API接続状態パネル(夜間統合指示書 2026-09-01 §4.2)。
 *
 * ## 方針
 *
 * - **新しいBASE OAuthアプリ・認証情報を作らない。** 既に「特集ページ作成」
 *   機能が使っているBASE連携設定(BASE_CLIENT_ID/SECRET + Amplify Dataの
 *   BaseOAuthToken)をそのまま参照して、状態を表示するだけ。
 * - Client Secret / Access Token の**実値は一切表示しない**。
 *   「サーバー側に保存済み」という事実だけを示す。
 * - §6.1: 「未設定」と「確認できなかった」を混同しない。
 *
 * ## なぜ状態表示が要るのか
 *
 * 2026-09-01時点のStagingでは `BASE_CLIENT_ID`/`BASE_CLIENT_SECRET` が
 * 未設定で、`BaseOAuthToken` の行数も0だった。それにもかかわらず
 * `getBaseClient()` は黙ってモッククライアント(作り物の商品を返す)へ
 * フォールバックしており、画面上はどこにも「BASEに繋がっていない」と
 * 出ていなかった。状態が見えないこと自体が問題だったので、
 * まず見えるようにする。
 *
 * これはServer Component —— 接続状態はサーバー側でしか判定できず、
 * クライアントへ渡す必要があるのは表示用の文字列だけ。
 */
export function BaseSettingsPanel({ state }: { state: BaseConnectionState }) {
  const label =
    state.status === "CONNECTED"
      ? "接続済み"
      : state.status === "CREDENTIALS_ONLY"
        ? "未連携（アプリ認証情報のみ設定済み）"
        : state.status === "MOCK"
          ? "モックデータ使用中（開発用）"
          : "未設定";

  const labelClass =
    state.status === "CONNECTED" ? "text-green-700" : state.status === "NOT_CONFIGURED" ? "text-red-600" : "text-amber-600";

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-[12px] text-gray-500">
        BASEの商品情報を読み取るための接続設定です。特集ページ作成機能と同じ接続設定を使用します（BELLOがBASE用の認証情報を二重に持つことはありません）。
      </p>

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
              {state.hasAppCredentials ? "サーバー側に設定済み" : "未設定"}
            </span>
          </p>
          <p>
            BASEアカウント連携（OAuth）:{" "}
            <span className={state.hasOAuthToken ? "text-green-700" : "text-red-600"}>
              {state.hasOAuthToken ? "連携済み（トークンはサーバー側に保存）" : "未連携"}
            </span>
          </p>
          <p>
            商品データの取得元:{" "}
            <span className={state.usingRealApi ? "text-green-700" : "text-amber-600"}>
              {state.usingRealApi ? "BASEの実データ" : "開発用のモックデータ（実在しない商品）"}
            </span>
          </p>
        </div>

        {/* 実際の値ではなく「何をすればよいか」を示す。秘密値はここに出さない。 */}
        {state.status !== "CONNECTED" && (
          <details className="mt-3 text-[11px] text-gray-400">
            <summary className="cursor-pointer">接続するには</summary>
            <ol className="mt-1 list-decimal space-y-1 pl-4">
              {!state.hasAppCredentials && (
                <li>
                  BASEデベロッパー登録で取得したClient ID / Client Secretを、Amplifyの環境変数
                  <code className="mx-1 bg-gray-100 px-1">BASE_CLIENT_ID</code>
                  <code className="mx-1 bg-gray-100 px-1">BASE_CLIENT_SECRET</code>
                  および
                  <code className="mx-1 bg-gray-100 px-1">BASE_REDIRECT_URI</code>
                  へ設定します（値はサーバー側にのみ保存され、画面には表示されません）。
                </li>
              )}
              <li>設定後、BASE連携の認可画面でBELLOからのアクセスを許可します（BASEアカウントの所有者本人の操作が必要です）。</li>
            </ol>
          </details>
        )}
      </div>
    </div>
  );
}
