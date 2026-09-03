"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  clearGmailCredentialsAction,
  ingestMercariMailAction,
  setGmailCredentialsAction,
  type GmailStatus,
} from "@/app/actions/mercariMail";
import { callAction } from "./actionResult";

/**
 * 2026-09-03 指示書 §13/§14: メルカリShops問い合わせメールの取り込み設定。
 *
 * ── なぜメール経由なのかを画面にも書く ──────────────────────────
 *
 * §13「メルカリShops APIをBELLOが直接利用できない前提」。この背景を
 * 知らずに画面だけ見ると「なぜAPI連携しないのか」と読める。運用する人が
 * 判断を追えるように、理由を画面に残す。
 */
export function MercariMailPanel({ status, isAdmin }: { status: GmailStatus; isAdmin: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [query, setQuery] = useState(status.query);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  /** 直近の実行でGmailへ実際に渡した検索条件。表示値との一致確認に使う。 */
  const [lastQuery, setLastQuery] = useState<string | null>(null);

  async function handleIngest() {
    setBusy(true);
    setMessage(null);
    try {
      // callAction は戻り値が無い場合も失敗として扱う。以前は res.ok を
      // 直接触っていたため、アクションが解決しなかったときに
      // 「Cannot read properties of undefined (reading 'ok')」という
      // 利用者に何も伝えないメッセージが出ていた(actionResult.ts 参照)。
      const res = await callAction(() => ingestMercariMailAction());
      if (!res.ok) {
        setMessage({ kind: "error", text: res.error });
        return;
      }
      const r = res.data;
      const parts = [
        `取得 ${r.fetched}件`,
        `新規取り込み ${r.ingested}件`,
        `取り込み済み ${r.duplicated}件`,
        `対象外 ${r.skipped}件`,
      ];
      if (r.reprocessed > 0) parts.push(`再処理 ${r.reprocessed}件`);
      if (r.parseFailed > 0) parts.push(`解析失敗 ${r.parseFailed}件`);
      if (r.failed > 0) parts.push(`エラー ${r.failed}件`);
      setLastQuery(r.query || null);
      setMessage({
        kind: r.failed > 0 ? "error" : "success",
        text: [parts.join(" / "), ...r.messages].join("\n"),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 p-4 text-[13px] text-gray-800">
      <section className="border border-gray-300 bg-white p-4">
        <h3 className="mb-1 text-[14px] font-bold text-gray-900">メルカリShops 問い合わせメール取り込み</h3>
        <p className="text-[12px] leading-relaxed text-gray-600">
          メルカリShopsの問い合わせは、BELLOから直接APIで受信できません（API利用に必要な契約者向けの
          開発者ポータルへ到達できないため）。そのため、
          <strong>メルカリShopsから届く問い合わせ通知メールをGmailから読み取って</strong>
          取り込みます。読み取り専用の権限のみを使い、メールの削除や送信は行いません。
        </p>
        <dl className="mt-3 grid grid-cols-[9rem_1fr] gap-y-1">
          <dt className="text-gray-500">接続状態</dt>
          <dd className={status.configured ? "text-green-700" : status.state === "unconfigured" ? "text-red-600" : "text-amber-700"}>
            {status.configured
              ? "接続済み"
              : status.state === "unconfigured"
                ? "未設定"
                : status.state === "secret-missing"
                  ? "保存先が未作成"
                  : "確認できません"}
          </dd>
          <dt className="text-gray-500">検索条件</dt>
          <dd className="break-all font-mono text-[12px]">{status.query}</dd>

          {/* 取り込みを実行したら、**実際にGmailへ渡した条件**も出す。
              画面の表示だけを見ていると、保存値と実行値がずれていても
              気づけない —— 古いページを開いたままだと実際にずれる。 */}
          {lastQuery && (
            <>
              <dt className="text-gray-500">前回の実行条件</dt>
              <dd
                className={
                  lastQuery === status.query
                    ? "break-all font-mono text-[12px] text-gray-700"
                    : "break-all font-mono text-[12px] text-amber-700"
                }
              >
                {lastQuery}
                {lastQuery !== status.query && "  ← 表示と不一致。ページを再読み込みしてください"}
              </dd>
            </>
          )}
        </dl>

        {/* 「まだ入力していない」のか「読めなかった」のかを区別して出す。
            同じ「未設定」にすると、権限やSecret未作成が原因のときに
            「設定したのに反映されない」で調査が止まる。 */}
        {status.detail && (
          <p className="mt-3 border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900">{status.detail}</p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !status.configured}
            onClick={handleIngest}
            className="border border-gray-800 bg-gray-800 px-3 py-1.5 text-[12px] text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "取り込み中…" : "今すぐ取り込む"}
          </button>
          {isAdmin && !editing && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setClientId("");
                setClientSecret("");
                setRefreshToken("");
                setMessage(null);
                setEditing(true);
              }}
              className="border border-gray-400 bg-white px-3 py-1.5 text-[12px] hover:bg-gray-50 disabled:opacity-50"
            >
              {status.configured ? "認証情報を変更" : "認証情報を設定"}
            </button>
          )}
          {isAdmin && status.configured && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Gmailの認証情報を削除します。削除するとメルカリShopsの問い合わせを取り込めなくなります。よろしいですか？")) return;
                setBusy(true);
                const res = await callAction(() => clearGmailCredentialsAction());
                setMessage(res.ok ? { kind: "success", text: "認証情報を削除しました。" } : { kind: "error", text: res.error });
                setBusy(false);
                router.refresh();
              }}
              className="border border-red-300 bg-white px-3 py-1.5 text-[12px] text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              認証情報を削除
            </button>
          )}
        </div>

        {message && (
          <p
            className={`mt-3 whitespace-pre-wrap border p-2 text-[12px] ${
              message.kind === "success"
                ? "border-green-300 bg-green-50 text-green-800"
                : "border-red-300 bg-red-50 text-red-800"
            }`}
          >
            {message.text}
          </p>
        )}
      </section>

      {isAdmin && editing && (
        <section className="border border-gray-300 bg-white p-4">
          <h4 className="mb-1 text-[13px] font-bold text-gray-900">Gmail OAuth 認証情報</h4>
          <p className="mb-3 text-[12px] leading-relaxed text-gray-600">
            Google Cloud で作成したOAuthクライアントの値と、
            <code className="mx-1 bg-gray-100 px-1">https://www.googleapis.com/auth/gmail.readonly</code>
            スコープで取得したリフレッシュトークンを入力してください。
            保存先はAWS Secrets Managerで、Gitやログには残りません。保存後にこの画面へ読み戻すこともできません。
          </p>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">クライアントID</span>
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">クライアントシークレット</span>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">リフレッシュトークン</span>
              <input
                type="password"
                value={refreshToken}
                onChange={(e) => setRefreshToken(e.target.value)}
                autoComplete="off"
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">Gmail検索条件</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full border border-gray-300 px-2 py-1.5 font-mono text-[12px]"
              />
              <span className="mt-1 block text-[11px] text-gray-500">
                期間の指定（newer_than）は必ず残してください。外すと受信箱の全履歴を読み、
                何年も前の問い合わせが新着として通知されます。
              </span>
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setMessage(null);
                const res = await callAction(() => setGmailCredentialsAction({ clientId, clientSecret, refreshToken, query }));
                if (res.ok) {
                  setMessage({ kind: "success", text: "Gmailの認証情報を保存しました（接続確認済み）。" });
                  setClientId("");
                  setClientSecret("");
                  setRefreshToken("");
                  setEditing(false);
                  router.refresh();
                } else {
                  setMessage({ kind: "error", text: res.error });
                }
                setBusy(false);
              }}
              className="border border-gray-800 bg-gray-800 px-3 py-1.5 text-[12px] text-white hover:bg-gray-700 disabled:opacity-50"
            >
              接続確認して保存
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setClientId("");
                setClientSecret("");
                setRefreshToken("");
              }}
              className="border border-gray-400 bg-white px-3 py-1.5 text-[12px] hover:bg-gray-50"
            >
              キャンセル
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
