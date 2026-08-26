"use client";

import { useEffect, useState } from "react";

interface Template {
  id: string;
  name: string;
  body: string;
  isDefault: boolean;
}

export default function TemplatesSettingsPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState("");
  const [body, setBody] = useState(
    "【商品について】\n\n【サイズ】\n\n【商品の状態】\n\n【配送について】\n\n【注意事項】\n",
  );
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const json = await fetch("/api/settings/templates").then((r) => r.json());
    setTemplates(json.templates ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const json = await fetch("/api/settings/templates").then((r) => r.json());
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
      await fetch("/api/settings/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, body }),
      });
      setName("");
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("削除しますか？")) return;
    await fetch(`/api/settings/templates/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">商品説明テンプレート</h1>

      <form onSubmit={handleCreate} className="card space-y-3 p-5">
        <h2 className="section-title">新規テンプレート</h2>
        <input
          className="input"
          placeholder="テンプレート名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <textarea
          className="input h-40"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
        />
        <div className="flex justify-end">
          <button className="btn-primary" disabled={saving}>
            {saving ? "保存中…" : "追加"}
          </button>
        </div>
      </form>

      <div className="space-y-3">
        {templates.map((t) => (
          <div key={t.id} className="card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium">{t.name}</h3>
              <button className="btn-danger" onClick={() => handleDelete(t.id)}>
                削除
              </button>
            </div>
            <pre className="whitespace-pre-wrap text-xs text-slate-600">{t.body}</pre>
          </div>
        ))}
        {templates.length === 0 && <p className="text-sm text-slate-400">テンプレートはまだありません。</p>}
      </div>
    </div>
  );
}
