"use client";

import { useEffect, useState } from "react";

interface ShippingTemplateRow {
  id: string;
  name: string;
  type: string;
  mercariShippingConfigurationId: string | null;
  isDefault: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  KAZAIBIN: "家財便",
  TAKKYUBIN: "宅配便",
  FREE_SHIPPING: "全国送料無料",
  PICKUP: "直接引取",
  OTHER: "その他",
};

export default function ShippingSettingsPage() {
  const [templates, setTemplates] = useState<ShippingTemplateRow[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("KAZAIBIN");
  const [configId, setConfigId] = useState("");
  const [saving, setSaving] = useState(false);

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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch("/api/settings/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type, mercariShippingConfigurationId: configId || null }),
      });
      setName("");
      setConfigId("");
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

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">配送テンプレート</h1>
      <p className="text-sm text-slate-500">
        例: 家財便Aランク、佐川220サイズ、全国送料無料、直接引取 など（指示書28項）。
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

      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="p-3">名前</th>
              <th className="p-3">種別</th>
              <th className="p-3">Mercari Shipping Configuration ID</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="p-3">{t.name}</td>
                <td className="p-3">{TYPE_LABEL[t.type] ?? t.type}</td>
                <td className="p-3 font-mono text-xs">{t.mercariShippingConfigurationId ?? "-"}</td>
                <td className="p-3 text-right">
                  <button className="btn-danger" onClick={() => handleDelete(t.id)}>
                    削除
                  </button>
                </td>
              </tr>
            ))}
            {templates.length === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-slate-400">
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
