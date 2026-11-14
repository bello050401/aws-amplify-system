"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { QuantityPlanningPanel } from "../../../../components/inventory/quantityPlanning/QuantityPlanningPanel";
import { QuantityPlanningSettings } from "../../../../components/inventory/quantityPlanning/QuantityPlanningSettings";
import { previewSettingsPorts, quantityPreviewId, quantityPreviewPorts, quantityPreviewSource, type QuantityPreviewMode } from "../../../../lib/inventory/quantityPlanning/previewFixtures";

const storage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};
const settings = previewSettingsPorts(storage);

function Preview() {
  const query = useSearchParams();
  const mode = (query.get("fixture") ?? "registered") as QuantityPreviewMode;
  const ports = useMemo(() => quantityPreviewPorts(mode, storage), [mode]);
  if (query.has("settings")) return <main className="preview-main"><QuantityPlanningSettings ports={settings} /></main>;
  if (query.has("edit")) return <main className="preview-main"><h1>既存在庫編集（検証用の遷移先）</h1></main>;

  return <main className="preview-main">
    <h1 className="font-bold">在庫詳細（操作確認用）</h1>
    <p className="py-2">{quantityPreviewSource(mode).title}</p>
    <h2 className="mt-3 text-sm font-bold">更新履歴</h2>
    <p className="text-sm">画面確認用の固定データを表示しています。</p>
    <QuantityPlanningPanel key={mode} inventoryId={quantityPreviewId} ports={ports} canWrite={mode !== "viewer"}
      editHref={mode === "viewer" ? undefined : "/quantity?edit=1"} settingsHref={mode === "viewer" ? undefined : "/quantity?settings=1"}
      image={<img className="h-20 w-full object-cover" src="/bench.jpg" alt="商品画像（見本）" />} />
  </main>;
}

export default function PreviewPage() {
  return <Suspense fallback={<main className="preview-main">検証画面を読み込み中…</main>}><Preview /></Suspense>;
}
