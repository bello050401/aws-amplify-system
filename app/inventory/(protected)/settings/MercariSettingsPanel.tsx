"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  checkMercariConnectionAction,
  deleteMercariTokenAction,
  setMercariConnectionAction,
  type MercariConnectionActionResult,
} from "@/app/actions/mercariSecret";
import type { MercariTokenSource, MercariVerificationState } from "@/lib/listing/mercari/tokenAccess";

/**
 * ADMIN専用のMercari Shops接続設定パネル(BELLO統合業務OS指示書
 * 2026-08-30 §24)。TOKENとAPIクライアント名(User-Agent用)を1つの
 * 「Mercari Shops API接続設定」フォームへ統合し、どちらもこの画面から
 * 入力・検証・保存できる。TOKEN文字列は一度もこのコンポーネントの外
 * (Server Actionの戻り値)へは出ない。APIクライアント名はTOKENと違い
 * 秘匿情報そのものではないため、保存済みの値自体は表示して構わない。
 *
 * ## 夜間統合指示書(2026-09-01) §3.3/§6.7 で直した点
 *
 * 1. Server Actionの戻り値を無条件に`.success`参照しない。
 *    以前は`res.success`が`res === undefined`のときTypeErrorになり、
 *    その例外文言(`Cannot read properties of undefined (reading
 *    'success')`)がcatch経由でそのまま画面へ出ていた —— 実際に報告された
 *    エラーはこれ。Server Action側も必ず結果オブジェクトを返すよう
 *    作り直したが、UI側でも「想定外の戻り値」を日本語の安全な文言へ
 *    畳む(§3.3「undefined return禁止」「unexpected responseでも
 *    日本語の安全なエラー表示」)。
 *
 * 2. 状態を「未設定 / 接続済み / 設定済み(未検証) / 設定を確認できません」
 *    へ分離した(§3.4「接続済み/未設定/設定済み未検証/接続失敗等を
 *    混同しない」)。「設定済み(未検証)」は、送信元IPがMercari側に
 *    未登録で接続確認が取れない場合でもTOKENを保存できるようにした
 *    ことで生まれた正当な状態。
 *
 * 3. 「接続確認」ボタンを追加。IP登録が完了した後に、TOKENを入力し直さず
 *    に接続確認だけを再実行できる。
 */
export function MercariSettingsPanel({
  mercariConnected,
  mercariTokenSource,
  mercariEnvironment,
  mercariClientName,
  mercariClientNameSource,
  mercariVerification,
  mercariLastCheckedAt,
  mercariSecretReadError,
}: {
  mercariConnected: boolean;
  mercariTokenSource: MercariTokenSource;
  mercariEnvironment: "sandbox" | "production";
  /** 保存済みのAPIクライアント名(secrets-manager/env-fallbackどちらか、無ければnull) — TOKENと違い秘匿値ではないので、そのまま表示してよい。 */
  mercariClientName: string | null;
  mercariClientNameSource: MercariTokenSource;
  /** 保存済み設定について接続確認が取れているか。 */
  mercariVerification: MercariVerificationState;
  /** 最後に接続確認を試みた時刻(ISO8601)。 */
  mercariLastCheckedAt: string | null;
  /** Secretそのものを読めなかった場合の説明。nullでなければ「未設定」と表示してはいけない。 */
  mercariSecretReadError: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [clientNameInput, setClientNameInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "warning" | "error"; text: string } | null>(null);

  // 状態(§3.4): 直近の操作結果ではなく、サーバー側から渡された保存状態を
  // 基準にする。直近の操作が失敗しても、既存の保存済み設定自体は
  // §92により壊れていない。
  const status: "未設定" | "接続済み" | "設定済み（未検証）" | "設定を確認できません" = mercariSecretReadError
    ? "設定を確認できません"
    : !mercariConnected
      ? "未設定"
      : mercariVerification === "unverified"
        ? "設定済み（未検証）"
        : "接続済み";

  const statusClass =
    status === "接続済み"
      ? "text-green-700"
      : status === "設定済み（未検証）"
        ? "text-amber-600"
        : status === "設定を確認できません"
          ? "text-amber-600"
          : "text-red-600";

  /**
   * Server Actionの戻り値を、型どおりでない場合も含めて安全に畳む。
   * §3.3「raw JavaScript exceptionをUIへ出さない」「undefined return禁止」。
   */
  function toMessage(res: MercariConnectionActionResult | undefined | null, fallbackText: string): { kind: "success" | "warning" | "error"; text: string } {
    if (!res || typeof res !== "object" || typeof (res as { success?: unknown }).success !== "boolean") {
      return { kind: "error", text: fallbackText };
    }
    const text = typeof res.message === "string" && res.message.trim() ? res.message : fallbackText;
    if (!res.success) return { kind: "error", text };
    // 「保存はできたが接続確認は取れていない」を成功(緑)で見せると、
    // 使える状態になったと誤解される。警告(橙)として区別する。
    return { kind: res.status === "SAVED_UNVERIFIED" ? "warning" : "success", text };
  }

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
      const msg = toMessage(res, "保存に失敗しました。時間をおいて再試行してください。");
      setMessage(msg);
      if (msg.kind !== "error") {
        setTokenInput("");
        setEditing(false);
        router.refresh();
      }
    } catch {
      // Server Action自体が到達しなかった場合(通信断・セッション切れ等)。
      // 例外の文言は利用者の判断材料にならないため画面へは出さない。
      setMessage({ kind: "error", text: "保存できませんでした。通信状況を確認するか、ログインし直してから再試行してください。" });
    } finally {
      setBusy(false);
    }
  }

  async function handleCheck() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await checkMercariConnectionAction();
      setMessage(toMessage(res, "接続確認に失敗しました。時間をおいて再試行してください。"));
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "接続確認できませんでした。通信状況を確認するか、ログインし直してから再試行してください。" });
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
      const msg = toMessage(res, "削除に失敗しました。時間をおいて再試行してください。");
      setMessage(msg);
      if (msg.kind !== "error") router.refresh();
    } catch {
      setMessage({ kind: "error", text: "削除できませんでした。通信状況を確認するか、ログインし直してから再試行してください。" });
    } finally {
      setBusy(false);
    }
  }

  const messageClass = message?.kind === "success" ? "text-green-700" : message?.kind === "warning" ? "text-amber-600" : "text-red-600";

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

        {/* §6.1: Secretを読めなかったことを「未設定」と偽らない。 */}
        {mercariSecretReadError && <p className="mt-1 text-[11px] text-amber-600">{mercariSecretReadError}</p>}

        {status === "設定済み（未検証）" && (
          <p className="mt-1 text-[11px] text-amber-600">
            APIクライアント名とTOKENは保存されていますが、Mercariへの接続確認はまだ取れていません。Mercariは事前に申請された固定IPアドレス以外からのリクエストへHTTP
            404を返す仕様のため、送信元IPの登録が済むまで接続確認は成功しません。登録完了後に「接続確認」を実行してください。
          </p>
        )}

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
        {mercariLastCheckedAt && <p className="mt-1 text-[11px] text-gray-400">最終接続確認: {formatCheckedAt(mercariLastCheckedAt)}</p>}

        {!editing ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={startEditing} disabled={busy} className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              {mercariConnected ? "接続設定を変更" : "Mercari API接続設定を行う"}
            </button>
            {mercariConnected && mercariTokenSource === "secrets-manager" && (
              <button
                type="button"
                onClick={handleCheck}
                disabled={busy}
                className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                {busy ? "確認中…" : "接続確認"}
              </button>
            )}
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
              保存前にMercari Shops APIへ接続確認します。確認が取れなかった場合でも、原因がTOKENの誤りでなければ入力内容は保存され、「設定済み（未検証）」として扱われます（既に接続確認済みの設定がある場合は上書きしません）。
            </p>
          </div>
        )}

        {message && <p className={`mt-2 text-[12px] ${messageClass}`}>{message.text}</p>}

        {!mercariConnected && !editing && !mercariSecretReadError && (
          <p className="mt-1 text-[11px] text-gray-500">
            上のボタンから設定するか、サーバー環境変数 MERCARI_ACCESS_TOKEN / MERCARI_API_CLIENT_NAME で設定できます。環境(sandbox/production)はサーバー環境変数
            MERCARI_ENV で切り替えます(既定: sandbox)。
          </p>
        )}

        {/* BELLO統合業務OS指示書(2026-08-30) §90: 技術的な長文説明を通常
            画面へ常時表示しない。必要なら「詳細」へ折りたたむ。 */}
        <details className="mt-3 text-[11px] text-gray-400">
          <summary className="cursor-pointer">詳細（接続要件について）</summary>
          <p className="mt-1">
            Mercari Shops公式ドキュメントは、すべてのリクエストへ正しいUser-Agent（上記のAPIクライアント名を含む）を設定することを必須としています。
          </p>
          <p className="mt-1">
            またAPIの呼び出し元は、環境（sandbox / 本番）ごとに事前申請した固定IPアドレスである必要があります（範囲指定は不可、日本国内の固定IPで、他社と共有していないもの）。申請していないIPアドレスからのリクエストには、認証の成否にかかわらずHTTP
            404が返ります。
          </p>
        </details>
      </div>
    </div>
  );
}

/** ISO8601をそのまま出すと読みにくいので、日本語ロケールの日時へ整形する。壊れた値でも例外にしない。 */
function formatCheckedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
