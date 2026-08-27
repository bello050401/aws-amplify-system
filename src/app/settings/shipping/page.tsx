"use client";

import { useEffect, useState } from "react";
import { PREFECTURES } from "@/lib/constants/prefectures";

interface ShippingTemplateRow {
  id: string;
  name: string;
  type: string;
  mercariShippingConfigurationId: string | null;
  isDefault: boolean;
  rates: { id: string; destination: string; fee: number }[];
}

const TYPE_LABEL: Record<string, string> = {
  KAZAIBIN: "家財便",
  TAKKYUBIN: "宅配便",
  FREE_SHIPPING: "全国送料無料",
  PICKUP: "直接引取",
  OTHER: "その他",
};

interface RateDraft {
  destination: string;
  fee: string;
}

export default function ShippingSettingsPage() {
  const [templates, setTemplates] = useState<ShippingTemplateRow[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("KAZAIBIN");
  const [configId, setConfigId] = useState("");
  const [rates, setRates] = useState<RateDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    const json = await fetch("/api/settings/shipping").then((r) => r.json());
    setTemplates(json.templates ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const json = await fetch("/api/settings/shipping").then((r) => r.json());
      if (cancelled) return;
      setTemplates(json.templates ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function addRateRow() {
    setRates((prev) => [...prev, { destination: "", fee: "" }]);
  }

  function updateRate(index: number, patch: Partial<RateDraft>) {
    setRates((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRateRow(index: number) {
    setRates((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const validRates = rates
        .filter((r) => r.destination && r.fee !== "")
        .map((r) => ({ destination: r.destination, fee: Math.trunc(Number(r.fee)) }));
      const res = await fetch("/api/settings/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type,
          mercariShippingConfigurationId: configId || null,
          rates: validRates,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error ?? "保存に失敗しました。");
        return;
      }
      setName("");
      setConfigId("");
      setRates([]);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("削除しますか？")) return;
    await fetch(`/api/settings/shipping/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function handleCreateConfiguration(id: string) {
    setConfiguring(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/settings/shipping/${id}/create-configuration`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error ?? "配送設定の作成に失敗しました。");
        return;
      }
      setMessage(`配送設定を作成しました: ${json.configurationId}`);
      await refresh();
    } finally {
      setConfiguring(null);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">配送テンプレート</h1>
      <p className="text-sm text-slate-500">
        例: 家財便Aランク、佐川220サイズ、全国送料無料、直接引取 など（指示書28項）。
        都道府県別送料を登録すると、「Mercariへ配送設定を作成」から
        <code>createProductShippingConfiguration</code> を実行しMercari側のIDを自動保存できます
        （指示書27, 29項）。
      </p>

      <form onSubmit={handleCreate} className="card space-y-3 p-5">
        <h2 className="section-title">新規テンプレート</h2>
        <input
          className="input"
          placeholder="テンプレート名（例: 家財便Aランク）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(TYPE_LABEL).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="label mb-0">都道府県別送料（任意、後から追加も可）</span>
            <button type="button" className="btn-secondary" onClick={addRateRow}>
              + 行を追加
            </button>
          </div>
          {rates.map((r, i) => (
            <div key={i} className="flex gap-2">
              <select
                className="input"
                value={r.destination}
                onChange={(e) => updateRate(i, { destination: e.target.value })}
              >
                <option value="">都道府県を選択</option>
                {PREFECTURES.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                className="input w-32"
                type="number"
                placeholder="送料（円）"
                value={r.fee}
                onChange={(e) => updateRate(i, { fee: e.target.value })}
              />
              <button type="button" className="btn-danger" onClick={() => removeRateRow(i)}>
                削除
              </button>
            </div>
          ))}
        </div>

        <input
          className="input"
          placeholder="Mercari Shipping Configuration ID（作成済みの場合のみ、任意）"
          value={configId}
          onChange={(e) => setConfigId(e.target.value)}
        />
        <div className="flex justify-end">
          <button className="btn-primary" disabled={saving}>
            {saving ? "保存中…" : "追加"}
          </button>
        </div>
      </form>

      {message && <p className="text-sm text-slate-600">{message}</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="p-3">名前</th>
              <th className="p-3">種別</th>
              <th className="p-3">送料設定数</th>
              <th className="p-3">Mercari Shipping Configuration ID</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="p-3">{t.name}</td>
                <td className="p-3">{TYPE_LABEL[t.type] ?? t.type}</td>
                <td className="p-3">{t.rates.length}件</td>
                <td className="p-3 font-mono text-xs">{t.mercariShippingConfigurationId ?? "-"}</td>
                <td className="p-3 text-right">
                  <div className="flex justify-end gap-1.5">
                    {!t.mercariShippingConfigurationId && (
                      <button
                        className="btn-secondary"
                        disabled={t.rates.length === 0 || configuring === t.id}
                        onClick={() => handleCreateConfiguration(t.id)}
                      >
                        {configuring === t.id ? "作成中…" : "Mercariへ配送設定を作成"}
                      </button>
                    )}
                    <button className="btn-danger" onClick={() => handleDelete(t.id)}>
                      削除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {templates.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-400">
                  配送テンプレートはまだありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
