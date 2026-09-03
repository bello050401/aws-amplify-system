"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatJstDateTime } from "@/lib/inventory/formatJst";
import {
  deleteNotifyBotConnectionAction,
  resendWaitingDeliveriesAction,
  saveNotifyBotDisplayAction,
  sendTestNotificationAction,
  setNotifyBotConnectionAction,
  type NotifyBotStatus,
} from "@/app/actions/lineNotify";

/**
 * 2026-09-03 指示書 §4-2/§4-3/§6: LINE Botセクション。
 *
 * ── トークンはこの画面から外へ出ない ────────────────────────────
 *
 * 入力欄の値はServer Actionへ渡り、そのままAWS Secrets Managerへ入る。
 * 保存後は入力欄を空にし、**保存済みの値を画面へ読み戻さない**
 * (既存の LineSettingsPanel / MercariSettingsPanel と同じ)。
 * 読み戻せる作りにすると、画面を開けるだけの権限でトークンが読めてしまう。
 */

/** §4-2 の案内文。意味を変えずに読みやすく改行している。 */
const GUIDE_TEXT = [
  "現在、公式LINE・BASE・メルカリShopsに届いたお問い合わせについては、内容を自動で確認・分析し、返信文をご提案する仕組みとなっております。",
  "返信のご提案は、LINE Botを通じてお送りいたします。",
];

const GUIDE_AFTER_QR = [
  "上記のQRコードを読み取り、LINE Botを友だち追加してください。",
  "友だち追加後、新しいお問い合わせを受信すると、お問い合わせ内容・対象商品の情報とあわせて、返信文のご提案をLINEへ自動でお送りします。",
];

export function LineNotifyBotPanel({ status, isAdmin }: { status: NotifyBotStatus; isAdmin: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [channelSecret, setChannelSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [qrUrl, setQrUrl] = useState(status.settings.qrImageUrl ?? "");
  const [addUrl, setAddUrl] = useState(status.settings.addFriendUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const connectionLabel = status.connected ? "接続済み" : "未設定";
  const connectionClass = status.connected ? "text-green-700" : "text-red-600";
  const targetLabel = status.hasTarget
    ? `登録済み（${status.settings.targetDisplayName ?? "名前未取得"}）`
    : "未登録（友だち追加が必要です）";
  const targetClass = status.hasTarget ? "text-green-700" : "text-amber-700";

  async function run(fn: () => Promise<{ success: boolean; message: string }>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      setMessage({ kind: res.success ? "success" : "error", text: res.message });
      if (res.success) router.refresh();
      return res.success;
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "操作に失敗しました。" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 p-4 text-[13px] text-gray-800">
      {/* ── §4-2 案内 ────────────────────────────────────────── */}
      <section className="border border-gray-300 bg-white p-4">
        {GUIDE_TEXT.map((t) => (
          <p key={t} className="mb-2 leading-relaxed">
            {t}
          </p>
        ))}

        <p className="mb-2 mt-4 font-bold">【LINE Bot 友だち追加QRコード】</p>

        {/* §4-3 未設定でも壊れた画像を出さない。 */}
        {status.settings.qrImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- 外部URL(LINE提供)を差し替え可能な設定値として扱うため、next/imageのドメイン設定に縛られない<img>を使う
          <img
            src={status.settings.qrImageUrl}
            alt="LINE Bot 友だち追加QRコード"
            className="h-44 w-44 border border-gray-200 object-contain"
          />
        ) : (
          <div className="flex h-44 w-44 items-center justify-center border border-dashed border-gray-300 bg-gray-50 text-[12px] text-gray-500">
            LINE BotのQRコードが未設定です
          </div>
        )}

        {status.settings.addFriendUrl && (
          <p className="mt-2">
            <a
              href={status.settings.addFriendUrl}
              target="_blank"
              rel="noreferrer"
              className="text-blue-700 underline hover:text-blue-900"
            >
              友だち追加リンクを開く
            </a>
          </p>
        )}

        {GUIDE_AFTER_QR.map((t) => (
          <p key={t} className="mt-3 leading-relaxed">
            {t}
          </p>
        ))}
      </section>

      {/* ── §6 接続状態 ──────────────────────────────────────── */}
      <section className="border border-gray-300 bg-white p-4">
        <h3 className="mb-3 text-[14px] font-bold text-gray-900">接続状態</h3>
        <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
          <dt className="text-gray-500">Bot接続</dt>
          <dd className={connectionClass}>{connectionLabel}</dd>

          <dt className="text-gray-500">Bot名</dt>
          <dd>{status.settings.botDisplayName ?? "—"}</dd>

          <dt className="text-gray-500">通知先</dt>
          <dd className={targetClass}>{targetLabel}</dd>

          <dt className="text-gray-500">最終通知日時</dt>
          <dd>{status.settings.lastNotifiedAt ? formatJstDateTime(status.settings.lastNotifiedAt) : "—"}</dd>

          <dt className="text-gray-500">直近の通知結果</dt>
          <dd>{status.settings.lastNotifyStatus ?? "—"}</dd>

          <dt className="text-gray-500">認証情報の保存先</dt>
          <dd>
            {status.tokenSource === "secrets-manager"
              ? "AWS Secrets Manager"
              : status.tokenSource === "env-fallback"
                ? "サーバー環境変数（暫定）"
                : "—"}
          </dd>
        </dl>

        {/* 接続はできているのに通知先が無い、という状態を明示する。
            これが一番気づきにくい —— 「接続済み」だけ見て送れると思ってしまう。 */}
        {status.connected && !status.hasTarget && (
          <div className="mt-3 border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900">
            <p>
              Botの接続はできていますが、通知先が未登録です。上のQRコード（または友だち追加リンク）からBotを友だち追加し、
              <strong>Botへ何かメッセージを1通送ってください。</strong>
            </p>
            {/* 「友だち追加してください」だけでは詰むことがある。
                follow は一度きりのイベントで、Webhook URLの設定前に追加して
                いた場合は二度と飛んでこない(LINEは再送しない)。実際にその
                状態になった。メッセージ送信ならいつでもやり直せる。 */}
            <p className="mt-1 text-amber-800">
              すでに友だち追加済みの場合、友だち追加の通知（follow）は一度しか送られないため、
              追加済みでも登録されないことがあります。その場合もBotへ1通送れば登録されます。
            </p>
          </div>
        )}

        {/* Webhookが実際に届いているかを画面から確かめられるようにする。
            これが無いと「LINE側の設定が悪い」のか「届いた後に失敗している」
            のかを利用者側から切り分けられない。 */}
        {status.settings.lastWebhookAt && (
          <dl className="mt-3 grid grid-cols-[9rem_1fr] gap-y-1 border border-gray-200 bg-gray-50 p-2 text-[12px]">
            <dt className="text-gray-500">最終Webhook受信</dt>
            <dd>{new Date(status.settings.lastWebhookAt).toLocaleString("ja-JP")}</dd>
            <dt className="text-gray-500">受信内容</dt>
            <dd className="break-all">{status.settings.lastWebhookResult ?? "—"}</dd>
          </dl>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !status.connected || !status.hasTarget}
            onClick={() => run(() => sendTestNotificationAction())}
            className="border border-gray-400 bg-white px-3 py-1.5 text-[12px] hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            テスト通知を送信
          </button>
          {/* §7 友だち追加前に溜まった通知を、上限付きでまとめて送る。 */}
          <button
            type="button"
            disabled={busy || !status.connected || !status.hasTarget}
            onClick={() => run(() => resendWaitingDeliveriesAction())}
            className="border border-gray-400 bg-white px-3 py-1.5 text-[12px] hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            通知待ちをまとめて送信
          </button>
          {isAdmin && !editing && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setChannelSecret("");
                setAccessToken("");
                setMessage(null);
                setEditing(true);
              }}
              className="border border-gray-400 bg-white px-3 py-1.5 text-[12px] hover:bg-gray-50 disabled:opacity-50"
            >
              {status.connected ? "認証情報を変更" : "認証情報を設定"}
            </button>
          )}
          {isAdmin && status.connected && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!window.confirm("社内通知Botの認証情報を削除します。削除すると問い合わせの通知が送信できなくなります。よろしいですか？")) return;
                void run(() => deleteNotifyBotConnectionAction());
              }}
              className="border border-red-300 bg-white px-3 py-1.5 text-[12px] text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              認証情報を削除
            </button>
          )}
        </div>

        {message && (
          <p
            className={`mt-3 border p-2 text-[12px] ${
              message.kind === "success"
                ? "border-green-300 bg-green-50 text-green-800"
                : "border-red-300 bg-red-50 text-red-800"
            }`}
          >
            {message.text}
          </p>
        )}
      </section>

      {/* ── §6-1 認証情報 ────────────────────────────────────── */}
      {isAdmin && editing && (
        <section className="border border-gray-300 bg-white p-4">
          <h3 className="mb-1 text-[14px] font-bold text-gray-900">社内通知Botの認証情報</h3>
          <p className="mb-3 text-[12px] text-gray-600">
            LINE Developers Console の「社内通知用チャネル」から取得した値を貼り付けてください。
            保存先はAWS Secrets Managerで、Gitやログには残りません。保存後にこの画面へ読み戻すこともできません。
            <br />
            これは<strong>顧客向けの公式LINEとは別のチャネル</strong>です。公式LINEの設定は「設定 ＞ LINE」から行ってください。
          </p>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">Channel Secret</span>
              <input
                type="password"
                value={channelSecret}
                onChange={(e) => setChannelSecret(e.target.value)}
                autoComplete="off"
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">Channel Access Token（長期）</span>
              <input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                autoComplete="off"
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
              />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const ok = await run(() => setNotifyBotConnectionAction({ channelSecret, accessToken }));
                if (ok) {
                  setChannelSecret("");
                  setAccessToken("");
                  setEditing(false);
                }
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
                setChannelSecret("");
                setAccessToken("");
              }}
              className="border border-gray-400 bg-white px-3 py-1.5 text-[12px] hover:bg-gray-50"
            >
              キャンセル
            </button>
          </div>
        </section>
      )}

      {/* ── §4-3 QRの差し替え ────────────────────────────────── */}
      {isAdmin && (
        <section className="border border-gray-300 bg-white p-4">
          <h3 className="mb-1 text-[14px] font-bold text-gray-900">友だち追加の案内（QRコード）</h3>
          <p className="mb-3 text-[12px] text-gray-600">
            QR画像のURLと友だち追加リンクは、いつでも差し替えられます。認証情報を保存すると友だち追加リンクは自動で入ります。
          </p>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">QR画像のURL</span>
              <input
                type="url"
                value={qrUrl}
                onChange={(e) => setQrUrl(e.target.value)}
                placeholder="https://..."
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">友だち追加リンク</span>
              <input
                type="url"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                placeholder="https://line.me/R/ti/p/..."
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
              />
            </label>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => saveNotifyBotDisplayAction({ qrImageUrl: qrUrl, addFriendUrl: addUrl }))}
            className="mt-3 border border-gray-400 bg-white px-3 py-1.5 text-[12px] hover:bg-gray-50 disabled:opacity-50"
          >
            案内を保存
          </button>
        </section>
      )}
    </div>
  );
}
