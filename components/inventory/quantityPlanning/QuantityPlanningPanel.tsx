"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  allocation, estimatedArea, issueMessage, maintenanceChoices, missingStockIssues, planningCaveat,
  resultDetails, resultFacts, sourceFacts, stockIssue, storageMethods, units,
} from "../../../lib/inventory/quantityPlanning/presentation";
import { useQuantityPlanning, type QuantityPlanningPorts } from "../../../lib/inventory/quantityPlanning/useQuantityPlanning";
import type { QuantityPlan, StorageMethod } from "../../../lib/inventory/quantityPlanning/types";

const primaryButton = "min-h-11 rounded-lg bg-emerald-800 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-900 disabled:opacity-50";
const secondaryButton = "min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 disabled:opacity-50";
const inputClass = "mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-base min-h-11";

function PlanResult({ plan, detailed = false }: { plan: QuantityPlan; detailed?: boolean }) {
  const { retailQuantity, wholesaleQuantity, retailPercentage } = allocation(plan);
  return <div className="space-y-4">
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="grid grid-cols-2 gap-2">
        <div className="text-emerald-800"><p className="text-sm font-bold">通常販売に残す</p><p className="break-all text-3xl font-black tabular-nums">{units(retailQuantity)}</p></div>
        <div className="text-sky-800"><p className="text-sm font-bold">業販に回す</p><p className="break-all text-3xl font-black tabular-nums">{units(wholesaleQuantity)}</p></div>
      </div>
      <div aria-hidden="true" className={`mt-3 flex h-3 overflow-hidden rounded-full ${retailQuantity + wholesaleQuantity ? "bg-sky-700" : "bg-gray-200"}`}>
        <div className="bg-emerald-700" style={{ width: `${retailPercentage}%` }} />
      </div>
    </div>
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
      {resultFacts(plan).map(([label, value]) => <div key={label} className="rounded-lg bg-gray-50 p-2.5">
        <dt className="text-gray-600">{label}</dt><dd className="break-words text-lg font-bold tabular-nums">{value}</dd>
      </div>)}
    </dl>
    {plan.inputs.area.source !== "inventory" && <p className="text-sm text-gray-700">{estimatedArea}。</p>}
    <p className="text-sm text-gray-600">{planningCaveat}</p>
    {detailed && <details className="rounded-lg border border-gray-200 bg-white p-3">
      <summary className="cursor-pointer py-1 text-sm font-semibold">価格・販売ペース・費用・面積の詳細</summary>
      <dl className="mt-2 grid gap-2 text-sm">
        {resultDetails(plan).map(([label, value], index) => <div key={index} className="border-t border-gray-100 py-2">
          <dt className="text-gray-600">{label}</dt><dd className="break-words font-medium">{value}</dd>
        </div>)}
      </dl>
    </details>}
  </div>;
}

export function QuantityPlanningPanel({ inventoryId, version, ports, canWrite, editHref, settingsHref, image }: {
  inventoryId: string;
  version?: string;
  ports: QuantityPlanningPorts;
  canWrite: boolean;
  editHref?: string;
  settingsHref?: string;
  image?: ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [nearby, setNearby] = useState(false);
  const state = useQuantityPlanning({ id: inventoryId, version, ports, enabled: nearby, canWrite, newOperationId: () => crypto.randomUUID() });
  const { source, snapshot, draft, open, busy, plan } = state;
  const canSave = canWrite && snapshot?.canEdit;

  useEffect(() => {
    const element = section.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearby(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNearby(true);
        observer.disconnect();
      }
    }, { rootMargin: "300px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearby) return;
    const onVisible = () => { if (document.visibilityState === "visible") void state.refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [nearby, state.refresh]);

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) {
      dialog.current.close();
      opener.current?.focus({ preventScroll: true });
    }
  }, [open]);

  function scrollToResult() {
    requestAnimationFrame(() => {
      result.current?.scrollIntoView({ block: "start" });
      result.current?.focus({ preventScroll: true });
    });
  }

  const issues = source ? [...new Map([...missingStockIssues(source), ...state.issues].map(issue => [issue.field, issue])).values()] : state.issues;
  const missingStock = issues.some(stockIssue);
  const missingArea = issues.some(issue => issue.field === "area");
  const latest = snapshot?.latest;

  return <section ref={section} aria-label="適正数量" className="my-8 max-w-4xl space-y-3 border-t border-gray-200 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-bold text-gray-900">適正数量</h2>
      <button ref={opener} type="button" className={primaryButton} disabled={!snapshot || state.loading} onClick={state.begin}>適正数量の計算</button>
    </div>
    {state.loading && !snapshot && <p role="status" className="text-sm text-gray-500">適正数量の保存結果を読み込み中…</p>}
    {state.readError && <div role="alert" className="space-y-2 text-sm text-red-800"><p>{state.readError}</p>
      <button type="button" className={secondaryButton} onClick={() => void state.refresh()}>読み込みを再試行</button>
    </div>}
    {latest && <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-bold">保存済みの計算結果</h3>
        <time dateTime={latest.calculatedAt} className="text-xs text-gray-600">{new Date(latest.calculatedAt).toLocaleString("ja-JP")}</time>
      </div>
      {snapshot.stale && <p role="status" className="rounded-lg bg-amber-50 p-2 text-sm font-bold text-amber-900">再計算が必要です。在庫または計算設定が更新されています。</p>}
      <PlanResult plan={latest.calculation.plan} detailed />
    </div>}
    <dialog
      ref={dialog} aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); state.close(); }}
      className="my-auto max-h-[100dvh] w-full max-w-[44rem] overflow-y-auto overscroll-contain bg-white text-gray-900 backdrop:bg-gray-900/60 sm:max-h-[90dvh] sm:rounded-2xl"
    >
      {open && source && <>
        <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-2 sm:px-6">
          <h2 id={titleId} className="text-lg font-bold">適正数量の計算</h2>
          <button type="button" className={secondaryButton} disabled={!!busy} onClick={state.close}>閉じる</button>
        </header>
        <div className="space-y-5 px-4 pb-6 pt-4 sm:px-6">
          <section aria-label="商品情報" className="space-y-3">
            <div className="flex items-center gap-3">
              {image && <div className="w-24 shrink-0 overflow-hidden rounded-lg bg-gray-100">{image}</div>}
              <div className="min-w-0">
                <h3 className="break-words text-base font-bold">{source.title}</h3>
                <p className="mt-1 break-words text-sm text-gray-600">カテゴリ {source.categoryName ?? source.workflowCategoryName ?? "未登録"}</p>
                <p className="break-words text-sm text-gray-600">ブランド {source.brand ?? "未登録"}</p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-2">
              {sourceFacts(source).map(([label, value]) => <div key={label} className="min-w-0 rounded-lg bg-gray-50 p-2 sm:p-3">
                <dt className="text-xs font-medium text-gray-700">{label}</dt><dd className="break-all text-xl font-extrabold tabular-nums sm:text-2xl">{value}</dd>
              </div>)}
            </dl>
          </section>

          <form className="space-y-5" noValidate onSubmit={event => {
            event.preventDefault();
            void state.calculate().then(success => { if (success) scrollToResult(); });
          }}>
            <fieldset disabled={!!busy || state.loading} className="min-w-0 space-y-4">
              <legend className="mb-2 text-base font-bold">計算条件</legend>
              <div>
                <p className="text-sm font-bold">販売ペース</p>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <label className="text-sm">販売期間（ヶ月）<input inputMode="decimal" value={draft.saleMonths} onChange={event => state.change({ saleMonths: event.target.value })} className={inputClass} /></label>
                  <label className="text-sm">販売見込み（個）<input inputMode="numeric" value={draft.saleCount} onChange={event => state.change({ saleCount: event.target.value })} className={inputClass} /></label>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-gray-600">まとめ買いも含め、期間内に合計何個売れるかを入力してください。</p>
              </div>
              <label className="block text-sm font-bold">
                残りのメンテナンス時間（1個あたり）
                <select className={inputClass} value={draft.maintenanceMinutes ?? ""} onChange={event => state.change({ maintenanceMinutes: event.target.value === "" ? null : Number(event.target.value) })}>
                  <option value="">選択してください</option>
                  {maintenanceChoices.map(value => <option key={value} value={value}>{value}分</option>)}
                </select>
                <span className="mt-1 block text-xs font-normal leading-relaxed text-gray-600">これから必要な作業のみ。完了済みの場合は0分を選択してください。</span>
              </label>
              <fieldset className="min-w-0">
                <legend className="mb-1 text-sm font-bold">保管方法</legend>
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(storageMethods).map(([key, label]) => <label key={key} className={`flex min-h-11 cursor-pointer items-center justify-center gap-1 rounded-lg border px-1 text-sm ${draft.storageMethod === key ? "border-emerald-700 bg-emerald-50 font-bold" : "border-gray-300"}`}>
                    <input type="radio" name={`storage-${titleId}`} value={key} checked={draft.storageMethod === key} onChange={() => state.change({ storageMethod: key as StorageMethod })} className="accent-emerald-800" />{label}
                  </label>)}
                </div>
              </fieldset>
              {source.plannedUnitPriceYen === null && <label className="block text-sm font-bold">予定販売価格（1個あたり・円）
                <input inputMode="decimal" value={draft.manualPrice} onChange={event => state.change({ manualPrice: event.target.value })} className={inputClass} />
                <span className="mt-1 block text-xs font-normal text-gray-600">入力した価格は計算条件として保存します。</span>
              </label>}
            </fieldset>
            {(issues.length > 0 || state.error || state.readError) && <div role="alert" className="space-y-2 rounded-lg bg-red-50 p-3 text-sm text-red-900">
              {issues.map(issue => <p key={issue.field}>{issueMessage(issue)}</p>)}
              {missingStock && (editHref ? <a href={editHref} className="block min-h-11 py-2 font-bold underline">在庫を編集する</a> : <p>在庫編集権限のあるスタッフへ登録を依頼してください。</p>)}
              {missingArea && (settingsHref ? <a href={settingsHref} className="block min-h-11 py-2 font-bold underline">カテゴリの保管面積設定を開く</a> : <p>管理者へ保管面積の設定を依頼してください。</p>)}
              {state.error && <p>{state.error}</p>}
              {state.readError && <p>{state.readError}</p>}
            </div>}
            {state.needsRecalculation && <p role="status" className="rounded-lg bg-amber-50 p-2 text-sm font-bold text-amber-900">{state.sourceChanged ? "元の在庫または設定が更新されています。" : state.inputsChanged ? "計算条件が変更されています。" : ""} 再計算が必要です。</p>}
            <button type="submit" className={primaryButton} disabled={!!busy || state.loading || missingStock}>{busy === "calculate" ? "計算中…" : plan ? "再計算" : "計算する"}</button>
          </form>
          {plan && <div ref={result} tabIndex={-1} className="scroll-mt-20 space-y-3" aria-label="計算結果">
            <PlanResult plan={plan} detailed />
            {canSave ? <button type="button" className={primaryButton} disabled={!state.canSave} onClick={() => void state.save()}>
              {busy === "save" ? "保存中…" : "計算結果を保存"}
            </button> : <p className="text-sm text-gray-600">計算結果の保存には在庫の編集権限が必要です。</p>}
          </div>}
        </div>
      </>}
    </dialog>
  </section>;
}
