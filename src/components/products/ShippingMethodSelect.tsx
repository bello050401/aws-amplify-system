"use client";

import { useEffect, useState } from "react";

interface ShippingMethodRow {
  code: string;
  label: string;
}

/**
 * 配送方法選択（指示書26項）。ハードコードに依存せず、まずMercari Shops APIの
 * Schemaから動的取得し、失敗時のみ最小限のフォールバックを表示する。
 */
export function ShippingMethodSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (code: string | null) => void;
}) {
  const [methods, setMethods] = useState<ShippingMethodRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const json = await fetch("/api/mercari/shipping-methods").then((r) => r.json());
      if (cancelled) return;
      setMethods(json.methods ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">選択してください</option>
      {methods.map((m) => (
        <option key={m.code} value={m.code}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
