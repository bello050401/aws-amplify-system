"use client";

import { useEffect, useState } from "react";

interface DescriptionTemplateRow {
  id: string;
  name: string;
  body: string;
}

export function DescriptionTemplateSelect({ onApply }: { onApply: (body: string) => void }) {
  const [templates, setTemplates] = useState<DescriptionTemplateRow[]>([]);
  const [selected, setSelected] = useState("");

  useEffect(() => {
    fetch("/api/settings/templates")
      .then((r) => r.json())
      .then((json) => setTemplates(json.templates ?? []));
  }, []);

  return (
    <div className="flex items-center gap-2">
      <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">説明テンプレートを選択</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn-secondary shrink-0"
        onClick={() => {
          const t = templates.find((tpl) => tpl.id === selected);
          if (t) onApply(t.body);
        }}
        disabled={!selected}
      >
        適用
      </button>
    </div>
  );
}
