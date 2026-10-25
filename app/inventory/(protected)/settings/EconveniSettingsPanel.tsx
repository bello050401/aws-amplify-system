"use client";

import { useEffect, useRef, useState } from "react";
import { getEconveniSettingsAction, saveEconveniSettingsAction } from "@/app/actions/econveniSettings";
import type { EconveniCredentialsState } from "@/lib/listing/econveni/credentials";

export function EconveniSettingsPanel() {
  const [state, setState] = useState<EconveniCredentialsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const sending = useRef(false);
  useEffect(() => {
    let active = true;
    void getEconveniSettingsAction().then(result => {
      if (!active) return;
      if (result.ok) { setState(result.state); setEditing(!result.state.configured); }
      else setError(result.message);
    }).catch(() => { if (active) setError("設定を読み込めませんでした。ページを再読み込みしてください。"); })
      .finally(() => { if (active) setLoading(false); });
    const element = form.current;
    return () => { active = false; element?.reset(); };
  }, []);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setBusy(true); setError(""); setNotice("");
    const element = event.currentTarget;
    const data = new FormData(element);
    try {
      const result = await saveEconveniSettingsAction({
        loginId: String(data.get("loginId") ?? ""),
        password: String(data.get("password") ?? ""),
      });
      if (result.ok) {
        setState(result.state); setEditing(false); setNotice(result.message ?? "保存しました。");
      } else setError(result.message);
    } catch { setError("保存結果を確認できませんでした。再読み込みして設定状態を確認してください。"); }
    finally {
      // Do not retain input in React state, browser storage, or after a failed request.
      element.reset(); data.delete("password"); data.delete("loginId");
      sending.current = false; setBusy(false);
    }
  }

  return (
    <section className="max-w-2xl rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-lg font-bold">eコンビニ連携</h2>
      <p className="mt-2 text-sm text-gray-600">eコンビニでお使いのログインIDとパスワードを登録してください。</p>
      <p className="mt-2 text-xs text-gray-500">入力内容は暗号化してAWS側に保管します。保存後は再表示しません。</p>
      {loading && <p role="status" className="mt-4 text-sm">設定を読み込み中…</p>}
      {state && <div className="mt-4 rounded-lg bg-gray-50 p-3 text-sm">
        <p className="font-semibold">{state.configured ? "ログイン情報：保存済み" : "ログイン情報：未設定"}</p>
        <p className="mt-1 text-gray-600">接続確認：未完了</p>
        {state.updatedAt && <p className="mt-1 text-xs text-gray-500">保存日時：{new Date(state.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>}
      </div>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
      {state && editing && <form ref={form} onSubmit={save} autoComplete="off" className="mt-5 space-y-4">
        <label className="block text-sm font-medium">ログインID
          <input name="loginId" required maxLength={256} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base" />
        </label>
        <label className="block text-sm font-medium">パスワード
          <input name="password" type="password" required maxLength={1024} autoComplete="new-password" disabled={busy}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base" />
        </label>
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="rounded-md bg-gray-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? "保存中…" : "ログイン情報を保存"}</button>
          {state.configured && <button type="button" disabled={busy} onClick={() => { form.current?.reset(); setEditing(false); }} className="rounded-md border border-gray-300 px-4 py-2 text-sm">キャンセル</button>}
        </div>
      </form>}
      {state?.configured && !editing && <button type="button" onClick={() => { setEditing(true); setNotice(""); }} className="mt-4 rounded-md border border-gray-300 px-4 py-2 text-sm">ログイン情報を変更</button>}
      <p className="mt-5 text-sm text-gray-600">現在は接続の準備段階です。保存だけでは商品登録・出品は行われません。</p>
    </section>
  );
}
