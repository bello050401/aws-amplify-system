"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  QuantityAreaStandard, QuantityPlanningSettingsResult, QuantityPlanningSettingsSaveRequest,
} from "../../../lib/inventory/quantityPlanning/contracts";
import type { StorageMethod } from "../../../lib/inventory/quantityPlanning/types";
import { storageMethods } from "../../../lib/inventory/quantityPlanning/presentation";

type ReadSettings = Extract<QuantityPlanningSettingsResult, { status: "ok" }>;
export type QuantityPlanningSettingsPorts = {
  read: () => Promise<QuantityPlanningSettingsResult>;
  save: (request: QuantityPlanningSettingsSaveRequest) => Promise<QuantityPlanningSettingsResult>;
};
type StandardDraft = Omit<QuantityAreaStandard, "areaM2PerBlock" | "unitsPerBlock" | "disassemblyMinutes" | "reassemblyMinutes"> & {
  areaM2PerBlock: string;
  unitsPerBlock: string;
  disassemblyMinutes: string;
  reassemblyMinutes: string;
};
type SettingsDraft = {
  allowance: string;
  standards: StandardDraft[];
  expenses: string[];
  work: string[];
  workExpenseIds: string[];
};

const input = "mt-1 block min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-base";
const secondary = "min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold disabled:opacity-50";
const channelLabels = { retail: "通常販売", wholesale: "業販" };
const expenseBasis = { "per-unit": "円／1個", once: "円／1回", "revenue-percent": "売上の％" };
const workBasis = { "per-unit": "分／1個", once: "分／SKU 1回" };
const blank: StandardDraft = {
  categoryId: "", method: "flat", source: "provisional-category", areaM2PerBlock: "", unitsPerBlock: "",
  reference: "", disassemblyMinutes: "", reassemblyMinutes: "",
};

function makeDraft(response: ReadSettings): SettingsDraft {
  const { settings } = response;
  return {
    allowance: String(settings.flatAllowancePercent),
    standards: settings.standards.map(row => ({
      ...row, areaM2PerBlock: String(row.areaM2PerBlock), unitsPerBlock: String(row.unitsPerBlock),
      disassemblyMinutes: String(row.disassemblyMinutes ?? ""), reassemblyMinutes: String(row.reassemblyMinutes ?? ""),
    })),
    expenses: settings.expenses.map(row => String(row.value ?? "")),
    work: settings.remainingWork.map(row => String(row.minutes ?? "")),
    workExpenseIds: settings.remainingWork.map(row => row.includedInExpenseId ?? ""),
  };
}

const nullableNumber = (value: string) => value.trim() === "" ? null : Number(value);
const decimalValue = (value: string) => value.trim() === "" ? null : value.trim();

export function QuantityPlanningSettings({ ports }: { ports: QuantityPlanningSettingsPorts }) {
  const [loaded, setLoaded] = useState<ReadSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);

  const read = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await ports.read();
      if (response.status !== "ok") return setError(response.message);
      setLoaded(response);
      setDraft(makeDraft(response));
    } catch {
      setError("適正数量の設定を取得できませんでした。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, [ports]);

  useEffect(() => { void read(); }, [read]);

  async function save() {
    if (lock.current || !loaded || !draft) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await ports.save({
        expectedRevision: loaded.revision, expectedTaxonomyRevision: loaded.taxonomyRevision,
        settings: {
          flatAllowancePercent: Number(draft.allowance),
          standards: draft.standards.map(row => ({
            ...row, reference: row.reference.trim(), areaM2PerBlock: Number(row.areaM2PerBlock),
            unitsPerBlock: row.method === "flat" ? 1 : Number(row.unitsPerBlock),
            disassemblyMinutes: row.method === "disassembled" ? nullableNumber(row.disassemblyMinutes) : null,
            reassemblyMinutes: row.method === "disassembled" ? nullableNumber(row.reassemblyMinutes) : null,
          })),
          expenses: loaded.settings.expenses.map((row, index) => ({ ...row, value: decimalValue(draft.expenses[index]) })),
          remainingWork: loaded.settings.remainingWork.map(({ includedInExpenseId: _previous, ...row }, index) => ({
            ...row, minutes: decimalValue(draft.work[index]),
            ...(draft.workExpenseIds[index] ? { includedInExpenseId: draft.workExpenseIds[index] } : {}),
          })),
        },
      });
      if (response.status !== "ok") return setError(response.message);
      setLoaded(response);
      setDraft(makeDraft(response));
      setNotice("適正数量の設定を保存しました。");
    } catch {
      setError("適正数量の設定を保存できませんでした。入力を保持しています。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function changeStandard(index: number, values: Partial<StandardDraft>) {
    setDraft(current => current && ({ ...current, standards: current.standards.map((row, position) => position === index ? { ...row, ...values } : row) }));
  }

  function changeValue(key: "expenses" | "work" | "workExpenseIds", index: number, value: string) {
    setDraft(current => current && ({ ...current, [key]: current[key].map((row, position) => position === index ? value : row) }));
  }

  return <section className="max-w-4xl space-y-4 text-gray-900" aria-label="適正数量の設定">
    <div>
      <h2 className="text-lg font-bold">適正数量の設定</h2>
      <p className="mt-1 text-sm text-gray-600">商品カテゴリごとの保管面積と、計算に使う今後の費用・作業時間を登録します。</p>
    </div>
    {busy && !loaded && <p role="status" className="text-sm">設定を読み込み中…</p>}
    {error && <div role="alert" className="space-y-2 rounded-lg bg-red-50 p-3 text-sm text-red-900">
      <p>{error}</p><button type="button" className={secondary} disabled={busy} onClick={() => void read()}>
        {loaded ? "最新設定を読み込む（入力を破棄）" : "読み込みを再試行"}
      </button>
    </div>}
    {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
    {loaded && draft && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="min-w-0 space-y-5">
        <div className="space-y-3 rounded-xl border border-gray-200 p-3">
          <h3 className="font-bold">保管面積</h3>
          <label className="block max-w-xs text-sm">平置きの共通余白（％）
            <input className={input} type="number" min="0" max="1000" step="any" required value={draft.allowance}
              onChange={event => setDraft({ ...draft, allowance: event.target.value })} />
          </label>
          <p className="text-sm text-gray-600">登録寸法を優先し、寸法・保管情報で算出できない場合にカテゴリの実測標準、暫定標準の順で使います。</p>
          {draft.standards.map((row, index) => <fieldset key={index} className="min-w-0 space-y-3 rounded-lg border border-gray-200 p-3">
            <legend className="px-1 text-sm font-semibold">カテゴリ標準 {index + 1}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-sm">商品カテゴリ
                <select className={input} required value={row.categoryId} onChange={event => changeStandard(index, { categoryId: event.target.value })}>
                  <option value="">選択してください</option>
                  {loaded.categories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}
                  {!!row.categoryId && !loaded.categories.some(category => category.id === row.categoryId) && <option value={row.categoryId}>{row.categoryId}（以前のカテゴリ）</option>}
                </select>
              </label>
              <label className="text-sm">保管方法
                <select className={input} value={row.method} onChange={event => changeStandard(index, { method: event.target.value as StorageMethod })}>
                  {Object.entries(storageMethods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </label>
              <label className="text-sm">標準の種類
                <select className={input} value={row.source} onChange={event => changeStandard(index, { source: event.target.value as StandardDraft["source"] })}>
                  <option value="measured-category">実測標準</option><option value="provisional-category">暫定標準</option>
                </select>
              </label>
              <label className="text-sm">{row.method === "flat" ? "1個あたりの面積（㎡）" : "1区画あたりの面積（㎡）"}
                <input className={input} type="number" min="0" max="1000000" step="any" required value={row.areaM2PerBlock}
                  onChange={event => {
                    changeStandard(index, { areaM2PerBlock: event.target.value });
                  }} />
              </label>
              {row.method !== "flat" && <label className="text-sm">1区画の収納数（個）
                <input className={input} type="number" min="1" step="1" required value={row.unitsPerBlock} onChange={event => changeStandard(index, { unitsPerBlock: event.target.value })} />
              </label>}
              {row.method === "disassembled" && <>
                <label className="text-sm">分解時間（分／1個）
                  <input className={input} type="number" min="0" max="100000" step="any" value={row.disassemblyMinutes} placeholder="未計上" onChange={event => changeStandard(index, { disassemblyMinutes: event.target.value })} />
                </label>
                <label className="text-sm">再組立時間（分／通常販売1個）
                  <input className={input} type="number" min="0" max="100000" step="any" value={row.reassemblyMinutes} placeholder="未計上" onChange={event => changeStandard(index, { reassemblyMinutes: event.target.value })} />
                </label>
              </>}
            </div>
            {row.method === "disassembled" && <p className="text-sm text-gray-600">天板、脚、金具、養生、支持具を含めた占有面積を登録してください。</p>}
            <label className="block text-sm">測定・見積もりの根拠
              <input className={input} maxLength={160} required value={row.reference} onChange={event => changeStandard(index, { reference: event.target.value })} />
            </label>
            <button type="button" className={secondary} onClick={() => setDraft({ ...draft, standards: draft.standards.filter((_, position) => position !== index) })}>このカテゴリ標準を削除</button>
          </fieldset>)}
          <button type="button" className={secondary} disabled={!loaded.categories.length}
            onClick={() => setDraft({ ...draft, standards: [...draft.standards, blank] })}>カテゴリ標準を追加</button>
          {!loaded.categories.length && <p className="text-sm text-gray-600">選択できる商品カテゴリがありません。</p>}
        </div>
        <div className="space-y-3 rounded-xl border border-gray-200 p-3">
          <h3 className="font-bold">今後の費用</h3>
          <p className="text-sm text-gray-600">空欄は未計上です。自社負担分と、今後発生する費用を入力してください。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {loaded.settings.expenses.map((row, index) => <label key={row.channel + row.id} className="text-sm">
              {row.label}（{channelLabels[row.channel]}・{expenseBasis[row.basis]}）
              <input type="number" className={input} min="0" max={row.basis === "revenue-percent" ? "100" : "1000000000"} step="any"
                value={draft.expenses[index]} placeholder="未計上" onChange={event => changeValue("expenses", index, event.target.value)} />
            </label>)}
          </div>
        </div>
        <div className="space-y-3 rounded-xl border border-gray-200 p-3">
          <h3 className="font-bold">残作業の標準時間</h3>
          <p className="text-sm text-gray-600">これから必要な作業の時間を入力してください。残作業と確認できた項目を計上します。別の費用に含まれる作業はその費用を選択してください。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {loaded.settings.remainingWork.map((row, index) => <div key={row.channel + row.id} className="space-y-2 rounded-lg bg-gray-50 p-3">
              <label className="block text-sm">
                {row.label}（{channelLabels[row.channel]}・{workBasis[row.basis]}）
                <input type="number" className={input} min="0" max="100000" step="any" value={draft.work[index]}
                  placeholder="未計上" onChange={event => changeValue("work", index, event.target.value)} />
                {row.id === "packing" && <span className="mt-1 block text-xs text-gray-600">現在は梱包の残作業を確認できる項目がないため、計算では未計上になります。</span>}
              </label>
              <label className="block text-sm">{row.label}を含む費用
                <select className={input} value={draft.workExpenseIds[index]} onChange={event => changeValue("workExpenseIds", index, event.target.value)}>
                  <option value="">別費用への含有設定なし</option>
                  {loaded.settings.expenses.filter(expense => expense.channel === row.channel).map(expense =>
                    <option key={expense.id} value={expense.id}>{expense.label}</option>)}
                </select>
              </label>
            </div>)}
          </div>
        </div>
        <button type="submit" className="min-h-11 rounded-lg bg-emerald-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? "保存中…" : "適正数量の設定を保存"}</button>
      </fieldset>
    </form>}
  </section>;
}
