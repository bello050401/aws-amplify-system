"use client";

import { useEffect, useState } from "react";
import { PRODUCT_CONDITIONS } from "@/integrations/mercari-shops/mapper/condition";
import { PREFECTURES } from "@/lib/constants/prefectures";

export default function MercariSettingsPage() {
  const [environment, setEnvironment] = useState<string>("sandbox");
  const [configured, setConfigured] = useState(false);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [defaultCondition, setDefaultCondition] = useState("SLIGHT_DAMAGE");
  const [defaultState, setDefaultState] = useState("");

  async function refresh() {
    const status = await fetch("/api/settings/mercari").then((r) => r.json());
    setEnvironment(status.environment);
    setConfigured(status.configured);
    const defaults = await fetch("/api/settings/defaults").then((r) => r.json());
    setDefaultCondition(defaults.condition ?? "SLIGHT_DAMAGE");
    setDefaultState(defaults.shippingFromStateId ?? "");
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await fetch("/api/settings/mercari").then((r) => r.json());
      const defaults = await fetch("/api/settings/defaults").then((r) => r.json());
      if (cancelled) return;
      setEnvironment(status.environment);
      setConfigured(status.configured);
      setDefaultCondition(defaults.condition ?? "SLIGHT_DAMAGE");
      setDefaultState(defaults.shippingFromStateId ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSaveToken(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/mercari", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error ?? "保存に失敗しました。");
        return;
      }
      setToken("");
      setMessage("トークンを保存しました。");
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDefaults(e: React.FormEvent) {
    e.preventDefault();
    await fetch("/api/settings/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ condition: defaultCondition, shippingFromStateId: defaultState }),
    });
    setMessage("デフォルト設定を保存しました。");
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">メルカリShops連携設定</h1>

      <div className="card space-y-2 p-5">
        <h2 className="section-title">現在の接続環境</h2>
        <p className="text-sm">
          環境:{" "}
          <span className="font-mono font-medium">
            {environment === "production" ? "Production（本番）" : "Sandbox（検証環境）"}
          </span>
        </p>
        <p className="text-sm">
          トークン設定: {configured ? "設定済み" : "未設定"}
        </p>
        <p className="text-xs text-slate-400">
          環境の切替は `.env` の <code>MERCARI_ENV</code> で行います（指示書33, 55項）。
          Phase 1完了条件を満たすまでは必ず sandbox を使用してください。
        </p>
      </div>

      <form onSubmit={handleSaveToken} className="card space-y-3 p-5">
        <h2 className="section-title">Personal API Access Token</h2>
        <input
          type="password"
          className="input"
          placeholder="トークンを入力"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="text-xs text-slate-400">
          トークンは暗号化してDBに保存されます。ログや画面上に平文で表示されることはありません。
        </p>
        <div className="flex justify-end">
          <button className="btn-primary" disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>

      <form onSubmit={handleSaveDefaults} className="card space-y-3 p-5">
        <h2 className="section-title">デフォルト設定</h2>
        <div>
          <label className="label">デフォルト商品状態</label>
          <select
            className="input"
            value={defaultCondition}
            onChange={(e) => setDefaultCondition(e.target.value)}
          >
            {PRODUCT_CONDITIONS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">デフォルト配送元地域</label>
          <select className="input" value={defaultState} onChange={(e) => setDefaultState(e.target.value)}>
            <option value="">未設定</option>
            {PREFECTURES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end">
          <button className="btn-primary">保存</button>
        </div>
      </form>

      {message && <p className="text-sm text-slate-600">{message}</p>}
    </div>
  );
}
