"use client";

import { useEffect, useState } from "react";

interface ShippingTemplateRow {
  id: string;
  name: string;
  type: string;
}

export function ShippingTemplateSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [templates, setTemplates] = useState<ShippingTemplateRow[]>([]);

  useEffect(() => {
    fetch("/api/settings/shipping")
      .then((r) => r.json())
      .then((json) => setTemplates(json.templates ?? []));
  }, []);

  return (
    <select
      className="input"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">配送テンプレートを選択（任意）</option>
      {templates.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
