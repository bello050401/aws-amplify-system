"use client";
import type {SelectionRequest} from '@/lib/inventory/selectionRequest';
import {inventoryEditErrorMessage} from '@/lib/inventory/editErrorMessage';
import {inventoryFieldLabel} from '@/lib/inventory/fieldLabel';
import {internalInventoryField} from '@/lib/inventory/humanEdits';
import type {InlineCustomDefinition} from '@/lib/inventory/customFieldEdits';
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { CategoryMultiSelect } from "../CategoryMultiSelect";
import { useInventorySelection } from "./InventorySelectionProvider";
import { useDirectEdit } from "./DirectEditProvider";
import { useUnsavedChanges } from "../UnsavedChangesProvider";
import {
  previewInventoryEdits,
  applyInventoryEdits,
  cancelInventoryEdits,
  inventoryEditJobStatus,
  inventoryRecentHistory,
  inventoryEditSelection,
  inventoryEditOperationTargets,
} from "@/app/actions/inventoryEditJobs";
import {
  BRACKETS,
  type InventoryEditRules,
  type NameRule,
  type BracketKind,
} from "@/lib/inventory/editTransform";
import type {
  EditJob,
  EditPreviewRow,
  EditJobMode,
} from "@/lib/inventory/editJobsCore";

const button =
  "min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium disabled:opacity-40";
const primaryButton = "min-h-11 rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-40";
const input =
  "min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base md:text-sm";
const emptyRules = (): InventoryEditRules => ({
  categories: { mode: "keep" },
  names: [],
});
const labels: Record<EditPreviewRow["state"], string> = {
  CHANGE: "変更あり",
  UNCHANGED: "変更なし",
  ERROR: "要確認",
  SAVED: "保存済み",
  CONFLICT: "競合",
  FAILED: "失敗",
};
const nameLabels: Record<NameRule["kind"], string> = {
  prefix: "先頭に文字を追加",
  remove: "指定文字をすべて削除",
  replace: "指定文字をすべて置換",
  brackets: "括弧を削除",
  convert: "括弧を変換",
};
const initialRule = (kind: NameRule["kind"]): NameRule =>
  kind === "prefix"
    ? { kind, text: "", skipExisting: true }
    : kind === "remove"
      ? { kind, text: "" }
      : kind === "replace"
        ? { kind, from: "", to: "" }
        : kind === "brackets"
          ? { kind, bracket: "memo", content: false }
          : { kind, from: "memo", to: "wide" };
function BracketChoice({
  value,
  onChange,
  label,
}: {
  value: BracketKind;
  onChange: (value: BracketKind) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      className={input}
      value={value}
      onChange={(event) => onChange(event.target.value as BracketKind)}
    >
      {Object.entries(BRACKETS).map(([key, chars]) => (
        <option key={key} value={key}>
          {chars.join(" ")}{" "}
          {key === "narrow" ? "半角" : key === "wide" ? "全角" : "隅付き"}
        </option>
      ))}
    </select>
  );
}
function NameRuleCard({
  rule,
  change,
}: {
  rule: NameRule;
  change: (r: NameRule) => void;
}) {
  if (rule.kind === "prefix")
    return (
      <>
        <input
          aria-label="追加する文字"
          className={input}
          placeholder="例：【市川確認】"
          value={rule.text}
          onChange={(e) => change({ ...rule, text: e.target.value })}
        />
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={rule.skipExisting}
            onChange={(e) =>
              change({ ...rule, skipExisting: e.target.checked })
            }
          />
          同じ文字が先頭にある場合は追加しない
        </label>
      </>
    );
  if (rule.kind === "remove")
    return (
      <input
        aria-label="削除する文字"
        className={input}
        value={rule.text}
        onChange={(e) => change({ ...rule, text: e.target.value })}
      />
    );
  if (rule.kind === "replace")
    return (
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs">
          変更前
          <input
            className={input}
            value={rule.from}
            onChange={(e) => change({ ...rule, from: e.target.value })}
          />
        </label>
        <label className="text-xs">
          変更後
          <input
            className={input}
            value={rule.to}
            onChange={(e) => change({ ...rule, to: e.target.value })}
          />
        </label>
      </div>
    );
  if (rule.kind === "brackets")
    return (
      <>
        <BracketChoice
          value={rule.bracket}
          onChange={(bracket) => change({ ...rule, bracket })}
          label="削除する括弧"
        />
        <select
          className={input}
          aria-label="括弧の削除方法"
          value={String(rule.content)}
          onChange={(e) =>
            change({ ...rule, content: e.target.value === "true" })
          }
        >
          <option value="false">括弧だけ削除して、中身を残す</option>
          <option value="true">括弧と中身をすべて削除する</option>
        </select>
      </>
    );
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="text-xs">
        変換元
        <BracketChoice
          value={rule.from}
          onChange={(from) => change({ ...rule, from })}
          label="変換元の括弧"
        />
      </label>
      <label className="text-xs">
        変換先
        <BracketChoice
          value={rule.to}
          onChange={(to) => change({ ...rule, to })}
          label="変換先の括弧"
        />
      </label>
    </div>
  );
}
export function InventoryBulkControls({
  categories,
  locations=[],
  customFieldDefs=[],
  embedded=false,
  initialRequest,
  onDismiss,
  onSaved,
  onWorking,
}: {
  categories: { id: string; name: string }[];
  locations?: { id: string; name: string }[];
  customFieldDefs?: (Pick<InlineCustomDefinition,'fieldKey'|'label'> & Partial<InlineCustomDefinition>)[];
  embedded?:boolean;
  initialRequest?: SelectionRequest;
  onDismiss?:()=>void;
  onSaved?:(ids:string[])=>void;
  onWorking?:(working:boolean)=>void;
}) {
  const selection = useInventorySelection(),
    direct = useDirectEdit(),
    router = useRouter();
  const {registerBlocker, guardedAction} = useUnsavedChanges();
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState<EditJobMode>("edit"),
    [rules, setRules] = useState<InventoryEditRules>(emptyRules),
    [job, setJob] = useState<EditJob | null>(null),
    [rows, setRows] = useState<EditPreviewRow[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState(0),
    [changedOnly, setChangedOnly] = useState(false),
    [history, setHistory] = useState<Awaited<
      ReturnType<typeof inventoryRecentHistory>
    > | null>(null);
  const [targetIds, setTargetIds] = useState<string[]>([]),
    [targetOperationId, setTargetOperationId] = useState<string | undefined>();
  const [targetState, setTargetState] = useState<
    Awaited<ReturnType<typeof inventoryEditSelection>>
  >([]);
  useEffect(() => {
    if (!open || history) return;
    let stale = false;
    inventoryEditSelection(targetIds)
      .then((rows) => {
        if (!stale) setTargetState(rows);
      })
      .catch((cause) => {
        if (!stale)
          setError(
            inventoryEditErrorMessage(cause, "対象を確認できません。"),
          );
      });
    return () => {
      stale = true;
    };
  }, [open, targetIds, Boolean(history)]);
  const panel = useRef<HTMLDivElement>(null),
    lock = useRef(false),
    applyInFlight = useRef(false),
    completed = useRef(""),
    previewAttempt = useRef<string | null>(null);
  const running = job?.state === "PREPARING" || job?.state === "APPLYING";
  const edited = rules.categories.mode !== "keep" || rules.names.length > 0 || Boolean(rules.location && rules.location.mode !== "keep") || Boolean(Object.keys(rules.customFieldChanges??{}).length);
  const unsaved = open && edited && (!job || job.state === "READY");
  useEffect(() => {
    registerBlocker("inventory-bulk", unsaved ? {discard: () => {
      setOpen(false); setRules(emptyRules()); setJob(null); setRows([]);
    }} : null);
    return () => registerBlocker("inventory-bulk", null);
  }, [registerBlocker, unsaved]);
  useEffect(() => {
    if (!open) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {document.body.style.overflow = old;};
  }, [open]);
  const selectedCount = selection.selected.size,
    names = new Map(categories.map((c) => [c.id, c.name]));
  function close() {
    if (running) {
      setOpen(false);
      return;
    }
    const dismiss=()=>{setOpen(false);onDismiss?.();};
    if (unsaved) guardedAction(dismiss);
    else dismiss();
  }
  function launch(next: EditJobMode, ids = [...selection.selected]) {
    setMode(next);
    setRules(emptyRules());
    setJob(null);
    setRows([]);
    setError("");
    setHistory(null);
    setTargetIds(ids);
    setTargetOperationId(undefined);
    setPage(0);
    setOpen(true);
    previewAttempt.current = null;
  }
  async function action(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(
        inventoryEditErrorMessage(cause, "通信結果を確認できません。再試行してください。"),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const changeRules = (next: InventoryEditRules) => {
    setRules(next);
    setJob(null);
    setRows([]);
    previewAttempt.current = null;
    setPage(0);
  };
  async function preview(ids = targetIds) {
    await action(async () => {
      previewAttempt.current ??= crypto.randomUUID();
      const created = await previewInventoryEdits({
        id: previewAttempt.current,
        ids,
        mode,
        rules: mode === "edit" ? rules : undefined,
        targetOperationId,
      });
      setJob(created);
      localStorage.setItem("bello.inventory.lastEditJob", created.id);
      setHistory(null);
      setPage(0);
    });
  }
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!job || (!running && (!['DONE','CANCELLED','FAILED'].includes(job.state) || completed.current === job.id))) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await inventoryEditJobStatus(job.id);
        if (stopped) return;
        if (result.job.state==='READY' && job.state==='APPLYING' && applyInFlight.current) {timer=setTimeout(poll,300);return;}
        if (result.job.state==='READY' && job.state==='APPLYING') {setError('適用が完了していません。内容を確認して再実行してください。');onWorking?.(false);}
        setJob(result.job);
        setRows(result.rows);
        if (["DONE", "CANCELLED", "FAILED"].includes(result.job.state)) {
          // Keep a fully successful selection so Undo/Redo remains one continuous flow.
          // With partial success, retain only the rows needing attention/retry.
          if (result.rows.some(r => r.state !== "SAVED" && r.state !== "UNCHANGED")) {
            selection.remove(result.rows.filter(r => r.state === "SAVED" || r.state === "UNCHANGED").map(r => r.id));
          }
          if (completed.current !== job.id) {
            completed.current = job.id;
            if (result.rows.some(r=>r.state==="SAVED")) onSaved?.(result.rows.filter(r=>r.state==="SAVED").map(r=>r.id));
            onWorking?.(false);
            if (!embedded) router.refresh();
          }
        } else timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (!stopped) {
          setError(
            inventoryEditErrorMessage(cause, "結果を確認できません。"),
          );
          timer = setTimeout(poll, 3000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // Selection changes on completion must not restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.state]);
  async function recent(ids = [...selection.selected]) {
    await action(async () => {
      setHistory(await inventoryRecentHistory(ids));
      setTargetIds(ids);
      setOpen(true);
      setJob(null);
      setRows([]);
      setRules(emptyRules());
    });
  }
  const launchedRequest = useRef<string | null>(null);
  useEffect(()=>{
    if (!initialRequest || launchedRequest.current===initialRequest.requestId || !selection.editable) return;
    launchedRequest.current=initialRequest.requestId;
    if(initialRequest.mode==='history') void recent(initialRequest.ids);
    else launch(initialRequest.mode,initialRequest.ids);
  },[initialRequest,selection.editable]);
  async function resume() {
    const id = localStorage.getItem("bello.inventory.lastEditJob");
    if (!id) {
      setError("この端末で開始した操作はありません。");
      return;
    }
    await action(async () => {
      const result = await inventoryEditJobStatus(id);
      setJob(result.job);
      setRows(result.rows);
      setMode(result.job.mode);
      setTargetIds(result.job.ids);
      setRules(result.job.rules ?? emptyRules());
      setHistory(null);
      setOpen(true);
    });
  }
  async function wholeOperation(id: string, direction: "undo" | "redo") {
    await action(async () => {
      const original = await inventoryEditOperationTargets(id);
      launch(direction);
      setTargetOperationId(id);
      setTargetIds(original.ids);
    });
  }
  useEffect(() => {
    const request = (event: Event) => {
      if (!selection.editable || direct.dirtyCount || lock.current || running) return;
      const detail = (event as CustomEvent).detail;
      if (!detail || !Array.isArray(detail.ids) || !detail.ids.length || detail.ids.length > 1000 ||
          detail.ids.some((id: unknown) => typeof id !== 'string') ||
          !['undo','redo'].includes(detail.mode) || typeof detail.operationId !== 'string') return;
      launch(detail.mode);
      setTargetIds(detail.ids);
      setTargetOperationId(detail.operationId);
    };
    window.addEventListener('bello:inventory-history-request', request);
    return () => window.removeEventListener('bello:inventory-history-request', request);
  }, [selection.editable, direct.dirtyCount, running]);
  function retryUnfinished() {
    const ids = targetIds.filter(
      (id) =>
        !rows.some(
          (row) => row.id === id && ["SAVED", "UNCHANGED"].includes(row.state),
        ),
    );
    setTargetIds(ids);
    setJob(null);
    setRows([]);
    setPage(0);
    previewAttempt.current = null;
    setError("");
  }
  const visible = changedOnly
    ? rows.filter((r) => r.state !== "UNCHANGED")
    : rows;
  const pendingErrors = rows.filter((r) => r.state === "ERROR"),
    changed = job?.counts.CHANGE ?? 0;
  const showValue = (value: unknown, field: string) =>
    field === "locationId" ? locations.find(l=>l.id===value)?.name ?? (value ? String(value) : "未設定") :
    field === "categoryIds"
      ? Array.isArray(value) && value.length
        ? value.map((id) => names.get(String(id)) ?? String(id)).join(" / ")
        : "なし"
      : value == null
        ? "未設定"
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
  const disabled = !selectedCount || direct.dirtyCount > 0 || busy || running;
  return (
    <>
      {selection.editable && !initialRequest && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-white px-4 py-2" role="toolbar" aria-label="選択商品の操作">
          <span className="mr-2 text-sm text-gray-500">{selectedCount ? selectedCount+'件選択中' : '行のチェックで商品を選択'}</span>
          <button type="button" className={primaryButton} disabled={disabled} onClick={()=>launch('edit')}>選択商品を編集</button>
          <button type="button" className={button} disabled={disabled} onClick={()=>launch('undo')}>戻る</button>
          <button type="button" className={button} disabled={disabled} onClick={()=>launch('redo')}>進む</button>
          <button type="button" className={button} disabled={disabled} onClick={()=>void recent()}>変更履歴</button>
          {selectedCount>0&&<button type="button" className="min-h-11 px-3 text-sm text-gray-600 underline" disabled={busy} onClick={selection.clear}>選択解除</button>}
          <button type="button" className={button+' ml-auto'} disabled={busy} onClick={resume}>前回の操作結果</button>
          {direct.dirtyCount>0&&<span className="text-xs text-amber-800">編集中の内容を保存またはキャンセルしてください</span>}
          {error&&!open&&<span role="alert" className="text-sm text-red-700">{error}</span>}
        </div>
      )}
      {initialRequest&&!open&&<div className="space-y-4 p-4"><p className="text-sm">{targetIds.length}件の商品を選択しています。</p><button type="button" className={button} onClick={()=>setOpen(true)}>処理結果を確認</button>{error&&<p role="alert">{error}</p>}</div>}
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] bg-black/25"
            onClick={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div
              ref={panel}
              role="dialog"
              aria-modal="true"
              aria-labelledby="bulk-title"
              tabIndex={-1}
              className={"absolute inset-y-0 right-0 flex w-full flex-col bg-slate-50 shadow-xl "+(embedded?"":"md:w-[min(900px,85vw)]")}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  close();
                }
                if (e.key === "Tab") {
                  const all = Array.from(
                    panel.current?.querySelectorAll<HTMLElement>(
                      'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
                    ) ?? [],
                  ).filter(element=>element.offsetParent!==null);
                  if (e.shiftKey && document.activeElement === all[0]) {
                    e.preventDefault();
                    all.at(-1)?.focus();
                  } else if (
                    !e.shiftKey &&
                    document.activeElement === all.at(-1)
                  ) {
                    e.preventDefault();
                    all[0]?.focus();
                  }
                }
              }}
            >
              <header className={embedded?"hidden":"flex items-center justify-between border-b bg-white px-5 py-4"}>
                <div>
                  <h2 id="bulk-title" className="text-lg font-semibold">
                    {history
                      ? "変更履歴"
                      : mode === "undo"
                        ? "保存済みの変更を戻す"
                        : mode === "redo"
                          ? "戻した変更を進める"
                          : targetIds.length===1 ? "商品を編集" : "選択商品をまとめて編集"}
                  </h2>
                  <p className="mt-1 text-sm text-gray-500">
                    対象 {targetIds.length}件
                  </p>
                </div>
                <button type="button" className={button} onClick={close}>
                  閉じる
                </button>
              </header>
              <main className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 md:p-6">
                {error && (
                  <div
                    role="alert"
                    className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
                  >
                    {error}
                  </div>
                )}
                {!history && (
                  <details className="rounded-xl border bg-white p-4">
                    <summary className="cursor-pointer text-sm font-medium">
                      対象商品・現在のカテゴリを確認（{targetIds.length}件）
                    </summary>
                    <div className="mt-3 grid gap-4 md:grid-cols-2">
                      <div className="max-h-56 space-y-2 overflow-y-auto text-sm">
                        {targetState.map((item) => (
                          <p key={item.id}>
                            {item.name}{" "}
                            <span className="text-xs text-gray-500">
                              {item.sku}
                            </span>
                          </p>
                        ))}
                      </div>
                      <div className="max-h-56 space-y-2 overflow-y-auto text-sm">
                        {categories.map((category) => {
                          const count = targetState.filter((row) =>
                            row.categoryIds.includes(category.id),
                          ).length;
                          return (
                            <div
                              key={category.id}
                              className="flex items-center gap-2"
                            >
                              <span
                                role="checkbox"
                                aria-checked={
                                  count === targetState.length && count > 0
                                    ? true
                                    : count > 0
                                      ? "mixed"
                                      : false
                                }
                                aria-readonly="true"
                                aria-label={`${category.name}、${targetState.length}件中${count}件に設定済み`}
                                className="inline-flex h-4 w-4 items-center justify-center rounded border text-xs"
                              >
                                {count === targetState.length && count > 0
                                  ? "✓"
                                  : count
                                    ? "−"
                                    : ""}
                              </span>
                              <span>{category.name}</span>
                              <span className="ml-auto text-xs text-gray-500">
                                {targetState.length}件中{count}件
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-gray-500">
                      現在の状態の表示です。下の追加・解除で指定したカテゴリだけ変更します。
                    </p>
                  </details>
                )}
                {history ? (
                  history.map((item) => (
                    <section
                      key={item.id}
                      className="space-y-3 rounded-xl border bg-white p-4"
                    >
                      <h3 className="font-medium">{item.name}</h3>
                      <p className="text-sm text-gray-500">
                        あと{item.history.cursor}回戻せます / あと
                        {item.history.entries.length - item.history.cursor}
                        回進めます
                      </p>
                      {item.history.entries.map((entry, i) => (
                        <div
                          key={entry.id}
                          className="rounded-lg border p-3 text-sm"
                        >
                          <p>
                            {new Date(entry.at).toLocaleString("ja-JP")} ·{" "}
                            {entry.source} · {entry.actor}
                          </p>
                          <p className="my-2">
                            {i < item.history.cursor
                              ? "適用中"
                              : "戻した変更（進むで再適用できます）"}
                            ：
                            {entry.changes
                              .map((c) =>
                                c.field === "name"
                                  ? "物品名"
                                  : c.field === "locationId" ? "保管場所" : c.field === "categoryIds"
                                    ? "カテゴリ"
                                    : c.field,
                              )
                              .join("、")}
                          </p>
                          {item.views.find(v=>v.id===entry.id)?.changes.map(change=><div key={change.field} className="my-3 grid gap-2 border-t pt-2 md:grid-cols-2"><div className="whitespace-pre-wrap break-words text-gray-500"><span className="block text-xs">変更前 · {inventoryFieldLabel(change.field,customFieldDefs)}</span>{change.before.present?showValue(change.before.value,change.field):'未設定'}</div><div className="whitespace-pre-wrap break-words text-teal-900"><span className="block text-xs">変更後</span>{change.after.present?showValue(change.after.value,change.field):'未設定'}</div></div>)}
                          {entry.blockedReason?<p className="text-amber-800">{entry.blockedReason}</p>:<div className="flex flex-wrap gap-2">
                           <button type="button" className={button} disabled={i!==item.history.cursor-1&&i!==item.history.cursor} onClick={()=>{launch(i===item.history.cursor?'redo':'undo');setTargetIds([item.id]);setTargetOperationId(entry.operationId);}}>{i<item.history.cursor?'この商品の変更を戻す':'この商品の変更を進める'}</button>
                           {entry.source==='一覧一括編集'&&<button type="button" className={button} disabled={busy} onClick={()=>wholeOperation(entry.operationId,i<item.history.cursor?'undo':'redo')}>{i<item.history.cursor?'この一括操作全体を戻す':'この一括操作全体を進める'}</button>}
                          </div>}
                        </div>
                      ))}
                      {!item.history.entries.length && (
                        <p className="text-sm text-gray-500">
                          戻せる保存履歴はありません。
                        </p>
                      )}
                    </section>
                  ))
                ) : (
                  <>
                    {mode === "edit" && !job && (
                      <>
                        <section className="space-y-4 rounded-xl border bg-white p-5">
                          <h3 className="font-semibold">カテゴリ</h3>
                          <select
                            aria-label="カテゴリの一括操作"
                            className={input}
                            value={rules.categories.mode}
                            onChange={(e) => {
                              const mode = e.target
                                .value as InventoryEditRules["categories"]["mode"];
                              changeRules({
                                ...rules,
                                categories:
                                  mode === "modify"
                                    ? { mode, add: [], remove: [] }
                                    : mode === "replace"
                                      ? { mode, ids: [] }
                                      : { mode },
                              });
                            }}
                          >
                            <option value="keep">変更しない</option>
                            <option value="modify">
                              ＋ 追加 / − 解除（現在のカテゴリを維持）
                            </option>
                            <option value="replace">
                              指定の組み合わせに置換
                            </option>
                            <option value="clear">全カテゴリを解除</option>
                          </select>
                          {rules.categories.mode === "modify" && (
                            <div className="grid gap-4 md:grid-cols-2">
                              <div>
                                <p className="mb-2 text-sm font-medium">
                                  ＋ 全対象に追加
                                </p>
                                <CategoryMultiSelect
                                  compact
                                  label="追加するカテゴリ"
                                  value={rules.categories.add}
                                  options={categories}
                                  onChange={(add) => {
                                    if (rules.categories.mode === "modify")
                                      changeRules({
                                        ...rules,
                                        categories: {
                                          ...rules.categories,
                                          add,
                                        },
                                      });
                                  }}
                                />
                              </div>
                              <div>
                                <p className="mb-2 text-sm font-medium">
                                  − 全対象から解除
                                </p>
                                <CategoryMultiSelect
                                  compact
                                  label="解除するカテゴリ"
                                  value={rules.categories.remove}
                                  options={categories}
                                  onChange={(remove) => {
                                    if (rules.categories.mode === "modify")
                                      changeRules({
                                        ...rules,
                                        categories: {
                                          ...rules.categories,
                                          remove,
                                        },
                                      });
                                  }}
                                />
                              </div>
                            </div>
                          )}
                          {rules.categories.mode === "replace" && (
                            <>
                              <p className="text-sm text-amber-800">
                                現在付いているカテゴリを、下記の組み合わせにすべて置き換えます。
                              </p>
                              <CategoryMultiSelect
                                compact
                                value={rules.categories.ids}
                                options={categories}
                                onChange={(ids) =>
                                  changeRules({
                                    ...rules,
                                    categories: { mode: "replace", ids },
                                  })
                                }
                              />
                            </>
                          )}
                          {rules.categories.mode === "clear" && (
                            <p className="text-sm text-red-700">
                              対象商品のカテゴリをすべて解除します。他の項目は各カードの指定に従います。
                            </p>
                          )}
                        </section>
                        {locations.length > 0 && <section className="space-y-3 rounded-xl border bg-white p-5">
                          <h3 className="font-semibold">保管場所</h3>
                          <select aria-label="保管場所の一括操作" className={input} value={rules.location?.mode ?? "keep"} onChange={e=>changeRules({...rules,location:e.target.value==="set"?{mode:"set",id:""}:{mode:e.target.value as "keep"|"clear"}})}>
                            <option value="keep">変更しない</option>
                            <option value="set">選択した保管場所に変更</option>
                            <option value="clear">保管場所を解除</option>
                          </select>
                          {rules.location?.mode === "set" && <select aria-label="変更先の保管場所" className={input} value={rules.location.id} onChange={e=>changeRules({...rules,location:{mode:"set",id:e.target.value}})}>
                            <option value="">選択してください</option>{locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}
                          </select>}
                          {rules.location?.mode === "clear" && <p className="text-sm text-amber-800">対象商品の保管場所を未設定にします。</p>}
                        </section>}
                        {customFieldDefs.some(d=>d.fieldType&&d.isActive!==false&&!internalInventoryField(d.fieldKey)) && <details className="space-y-4 rounded-xl border bg-white p-5">
                          <summary className="cursor-pointer font-semibold">追加項目 <span className="ml-2 text-sm font-normal text-gray-500">{Object.keys(rules.customFieldChanges??{}).length}項目を変更</span></summary>
                          <p className="text-sm text-gray-500">指定した項目だけを変更します。その他の記録はそのまま残ります。</p>
                          {customFieldDefs.filter(d=>d.fieldType&&d.isActive!==false&&!internalInventoryField(d.fieldKey)).map(def=>{
                            const patch=rules.customFieldChanges??{}, value=patch[def.fieldKey];
                            const mode=Object.hasOwn(patch,def.fieldKey)?value===null?'clear':'set':'keep';
                            const update=(next:string|number|null|undefined)=>{const fields={...patch};if(next===undefined)delete fields[def.fieldKey];else fields[def.fieldKey]=next;changeRules({...rules,customFieldChanges:fields});};
                            return <div key={def.fieldKey} className="space-y-2 border-t pt-3">
                              <label className="block text-sm font-medium" htmlFor={'bulk-custom-mode-'+def.fieldKey}>{def.label}{def.required?'（必須）':''}</label>
                              <select id={'bulk-custom-mode-'+def.fieldKey} aria-label={'追加項目「'+def.label+'」の一括操作'} className={input} value={mode} onChange={e=>update(e.target.value==='keep'?undefined:e.target.value==='clear'?null:'')}>
                                <option value="keep">変更しない</option><option value="set">値を指定する</option><option value="clear" disabled={def.required}>空欄にする</option>
                              </select>
                              {mode==='set'&&(def.fieldType==='SELECT'?<select aria-label={'追加項目「'+def.label+'」の値'} className={input} value={String(value??'')} onChange={e=>update(e.target.value)}><option value="">選択してください</option>{(def.options??[]).map(v=><option key={v} value={v}>{v}</option>)}</select>:def.fieldType==='TEXTAREA'?<textarea aria-label={'追加項目「'+def.label+'」の値'} className={input} rows={3} value={String(value??'')} onChange={e=>update(e.target.value)}/>:<input aria-label={'追加項目「'+def.label+'」の値'} className={input} type={def.fieldType==='NUMBER'?'number':def.fieldType==='DATE'?'date':'text'} step={def.fieldType==='NUMBER'?'any':undefined} value={value??''} onChange={e=>update(def.fieldType==='NUMBER'&&e.target.value!==''?Number(e.target.value):e.target.value)}/>)}
                              {mode==='clear'&&<p className="text-sm text-amber-800">選択した商品の「{def.label}」を空欄にします。</p>}
                            </div>;
                          })}
                        </details>}
                        <section className="space-y-4 rounded-xl border bg-white p-5">
                          <h3 className="font-semibold">物品名</h3>
                          {!rules.names.length && (
                            <p className="text-sm text-gray-500">変更しない</p>
                          )}
                          {rules.names.map((rule, index) => (
                            <div
                              key={index}
                              className="space-y-3 rounded-lg border bg-slate-50 p-3"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <strong className="mr-auto text-sm">
                                  {index + 1}. {nameLabels[rule.kind]}
                                </strong>
                                {([-1, 1] as const).map((step) => (
                                  <button
                                    key={step}
                                    type="button"
                                    className={button}
                                    aria-label={
                                      step === -1
                                        ? "ルールを上へ"
                                        : "ルールを下へ"
                                    }
                                    disabled={
                                      index + step < 0 ||
                                      index + step >= rules.names.length
                                    }
                                    onClick={() => {
                                      const names = [...rules.names];
                                      [names[index], names[index + step]] = [
                                        names[index + step],
                                        names[index],
                                      ];
                                      changeRules({ ...rules, names });
                                    }}
                                  >
                                    {step === -1 ? "↑" : "↓"}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  className={button}
                                  onClick={() =>
                                    changeRules({
                                      ...rules,
                                      names: rules.names.filter(
                                        (_, i) => i !== index,
                                      ),
                                    })
                                  }
                                >
                                  削除
                                </button>
                              </div>
                              <NameRuleCard
                                rule={rule}
                                change={(next) =>
                                  changeRules({
                                    ...rules,
                                    names: rules.names.map((r, i) =>
                                      i === index ? next : r,
                                    ),
                                  })
                                }
                              />
                            </div>
                          ))}
                          <select
                            aria-label="物品名の加工ルールを追加"
                            className={input}
                            value=""
                            onChange={(e) =>
                              changeRules({
                                ...rules,
                                names: [
                                  ...rules.names,
                                  initialRule(
                                    e.target.value as NameRule["kind"],
                                  ),
                                ],
                              })
                            }
                          >
                            <option value="">＋ 加工ルールを追加</option>
                            {Object.entries(nameLabels).map(
                              ([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ),
                            )}
                          </select>
                          <p className="text-xs text-gray-500">
                            上から順番に処理します。文字幅や空白は自動変更しません。
                          </p>
                        </section>
                      </>
                    )}
                    {mode !== "edit" && !job && (
                      <p className="rounded-xl border bg-white p-4 text-sm">
                        各商品の直前の保存1回分を
                        {mode === "undo" ? "戻します" : "進めます"}
                        。商品ごとに対象の変更は異なります。次のプレビューで変更前後を確認してください。
                      </p>
                    )}
                    {job && (
                      <>
                        <div
                          role="status"
                          className="rounded-xl border bg-white p-4"
                        >
                          <strong>
                            {job.state === "PREPARING"
                              ? "全対象の変更を確認中"
                              : job.state === "APPLYING"
                                ? "保存中"
                                : job.state === "READY"
                                  ? "変更内容のプレビュー"
                                  : job.state === "CANCELLED"
                                    ? "処理を停止しました"
                                    : "処理結果"}
                          </strong>
                          {job.error&&<p role="alert" className="mt-2 text-sm text-red-800">{job.error}</p>}
                          <div className="mt-2 flex flex-wrap gap-3 text-sm">
                            {Object.entries(job.counts).map(
                              ([state, count]) => (
                                <span key={state}>
                                  {labels[state as EditPreviewRow["state"]]}{" "}
                                  {count}件
                                </span>
                              ),
                            )}
                          </div>
                          {running && (
                            <p className="mt-2 text-sm text-gray-500">
                              {rows.length} / {job.count}
                              件を確認。{embedded ? '一覧に戻っても処理は続きます。結果の確認ボタンから戻れます。' : '画面を閉じても「前回の操作結果」から確認できます。'}
                            </p>
                          )}
                        </div>
                        {rows.some((r) => r.redoCount > 0) &&
                          mode === "edit" && (
                            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                              新しく保存すると、対象商品の進む履歴は消えます。
                            </p>
                          )}
                        {!!pendingErrors.length && job.state === "READY" && (
                          <button
                            className={button}
                            type="button"
                            onClick={() => {
                              const ids = targetIds.filter(
                                (id) => !pendingErrors.some((r) => r.id === id),
                              );
                              setTargetIds(ids);
                              selection.remove(pendingErrors.map((r) => r.id));
                              setJob(null);
                              setRows([]);
                              previewAttempt.current = null;
                            }}
                          >
                            エラー {pendingErrors.length}
                            件を対象から外し、再プレビューへ
                          </button>
                        )}
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={changedOnly}
                            onChange={(e) => {
                              setChangedOnly(e.target.checked);
                              setPage(0);
                            }}
                          />
                          変更あり・要確認だけ表示
                        </label>
                        <div className="space-y-3">
                          {visible
                            .slice(page * 25, (page + 1) * 25)
                            .map((row) => (
                              <article
                                key={row.id}
                                className="rounded-xl border bg-white p-4"
                              >
                                <div className="mb-3 flex items-start justify-between gap-3">
                                  <h3 className="min-w-0 break-words font-medium">
                                    {row.name}
                                    <span className="ml-2 text-xs font-normal text-gray-500">
                                      {row.sku}
                                    </span>
                                  </h3>
                                  <span
                                    className={
                                      "shrink-0 rounded px-2 py-1 text-xs " +
                                      (["ERROR", "FAILED", "CONFLICT"].includes(
                                        row.state,
                                      )
                                        ? "bg-red-50 text-red-800"
                                        : "bg-teal-50 text-teal-900")
                                    }
                                  >
                                    {labels[row.state]}
                                  </span>
                                </div>
                                {row.error && (
                                  <p className="text-sm text-red-700">
                                    {row.error}
                                  </p>
                                )}
                                {Object.keys(row.before).map((field) => (
                                  <div
                                    key={field}
                                    className="mt-2 grid gap-2 border-t pt-2 text-sm md:grid-cols-2"
                                  >
                                    <div className="whitespace-pre-wrap break-words text-gray-500">
                                      <span className="mb-1 block text-xs">
                                        変更前 ·{" "}
                                        {inventoryFieldLabel(field,customFieldDefs)}
                                      </span>
                                      {showValue(row.before[field], field)}
                                    </div>
                                    <div className="whitespace-pre-wrap break-words text-teal-900">
                                      <span className="mb-1 block text-xs">
                                        変更後
                                      </span>
                                      {showValue(row.after[field], field)}
                                    </div>
                                  </div>
                                ))}
                              </article>
                            ))}
                        </div>
                        {visible.length > 25 && (
                          <nav
                            aria-label="プレビューページ"
                            className="flex items-center justify-center gap-4"
                          >
                            <button
                              className={button}
                              disabled={!page}
                              onClick={() => setPage((p) => p - 1)}
                            >
                              前へ
                            </button>
                            <span>
                              {page + 1} / {Math.ceil(visible.length / 25)}
                            </span>
                            <button
                              className={button}
                              disabled={(page + 1) * 25 >= visible.length}
                              onClick={() => setPage((p) => p + 1)}
                            >
                              次へ
                            </button>
                          </nav>
                        )}
                      </>
                    )}
                  </>
                )}
              </main>
              {!history && (
                <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                  {running ? (
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          await cancelInventoryEdits(job!.id);
                        })
                      }
                    >
                      処理を停止（保存中の商品は完了します）
                    </button>
                  ) : job?.state === "READY" ? (
                    <>
                      <button
                        className={button}
                        onClick={() => {
                          setJob(null);
                          setRows([]);
                          previewAttempt.current = null;
                        }}
                      >
                        編集に戻る
                      </button>
                      <button
                        className={
                          primaryButton
                        }
                        disabled={busy || !!pendingErrors.length || !changed}
                        onClick={() =>
                          action(async () => {
                            // Poll even if the apply response is lost after the server accepted it.
                            applyInFlight.current=true;
                            onWorking?.(true);
                            setJob({...job,state:'APPLYING'});
                            try {setJob(await applyInventoryEdits(job.id));}
                            finally {applyInFlight.current=false;}
                          })
                        }
                      >
                        {changed}件に適用
                      </button>
                    </>
                  ) : !job ? (
                    <button
                      className={
                        primaryButton
                      }
                      disabled={busy || !targetIds.length}
                      onClick={() => preview()}
                    >
                      変更内容をプレビュー
                    </button>
                  ) : (
                    <>{targetIds.some(id=>!rows.some(row=>row.id===id&&['SAVED','UNCHANGED'].includes(row.state)))&&<button className={button} disabled={busy} onClick={retryUnfinished}>未保存の商品だけ再プレビュー</button>}<button className={button} onClick={close}>一覧へ戻る</button></>
                  )}
                </footer>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
