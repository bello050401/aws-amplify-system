"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { sortWholesaleRows, type WholesaleData, type WholesaleSaveRequest, type WholesaleSaveResult, type WholesaleSort } from "@/lib/listing/wholesale";

type Props = {
  initialData: WholesaleData | null;
  loadData: () => Promise<WholesaleData>;
  saveData: (request: WholesaleSaveRequest) => Promise<WholesaleSaveResult>;
};
const button = "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const columns: [WholesaleSort, string][] = [["purchaseAmount", "仕入額 / 点"], ["shipping", "送料 / 点"], ["totalCost", "総原価 / 点"], ["sellingDays", "販売日数"], ["quantity", "現在数量"]];
const number = (value: number | null, money = false) => value === null ? "—" : `${money ? "¥" : ""}${value.toLocaleString("ja-JP")}`;

export function WholesaleTable({ initialData, loadData, saveData }: Props) {
  const [data, setData] = useState(initialData);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: WholesaleSort; direction: "asc" | "desc" }>({ key: "sellingDays", direction: "desc" });
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<WholesaleSaveRequest | null>(null);
  const [message, setMessage] = useState(initialData ? "" : "一覧を取得できませんでした。再読込してください。");
  const [results, setResults] = useState<WholesaleSaveResult["results"]>([]);
  const rows = useMemo(() => sortWholesaleRows(data?.items ?? [], sort.key, sort.direction), [data, sort]);
  const editable = !!data?.canEdit && !!data.snapshotVersion && !pending && !busy;
  const selectable = rows.filter(row => !row.alreadyWholesale);
  function toggle(id: string) {
    if (!editable) return;
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      return next;
    });
  }
  async function reload() {
    if (guard.current || pending) return;
    guard.current = true; setBusy(true);
    try { setData(await loadData()); setSelected(new Set()); setResults([]); setMessage(""); }
    catch { setMessage("一覧の再取得に失敗しました。表示中の内容は前回の取得結果です。"); }
    finally { guard.current = false; setBusy(false); }
  }
  async function save(request?: WholesaleSaveRequest) {
    if (guard.current || !data?.canEdit || !data.snapshotVersion) return;
    const next = request ?? { mutationId: crypto.randomUUID(), snapshotVersion: data.snapshotVersion, items: data.items.filter(row => selected.has(row.id) && !row.alreadyWholesale).map(row => ({ id: row.id, expectedUpdatedAt: row.updatedAt })) };
    if (!next.items.length || next.items.length > 100) return;
    guard.current = true; setBusy(true); setConfirming(false); setMessage("");
    try {
      const response = await saveData(next);
      // A missing per-item response is an unknown outcome, never a success.
      const all = next.items.map(item => response.results.find(result => result.id === item.id) ?? { id: item.id, status: "unknown" as const, message: "結果が返されませんでした。" });
      setResults(all);
      const done = new Set(all.filter(result => result.status === "saved" || result.status === "already").map(result => result.id));
      setData(previous => previous && ({ ...previous, items: previous.items.map(row => done.has(row.id) ? { ...row, alreadyWholesale: true } : row) }));
      setSelected(previous => new Set([...previous].filter(id => !done.has(id))));
      const unknown = all.some(result => result.status === "unknown");
      setPending(unknown ? next : null);
      setMessage(`保存済み ${all.filter(result => result.status === "saved").length}件・設定済み ${all.filter(result => result.status === "already").length}件・失敗 ${all.filter(result => result.status === "failed").length}件・結果不明 ${all.filter(result => result.status === "unknown").length}件`);
    } catch {
      // A rejected server action can lose its response after a write. Keep the
      // exact request for reconciliation rather than creating a second mutation.
      setPending(next); setMessage("保存結果を確認できませんでした。結果不明です。同じ受付内容で確認してください。");
    } finally { guard.current = false; setBusy(false); }
  }
  return <div className="mx-auto max-w-[1600px] space-y-4 text-slate-800">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-bold">業販一覧</h2><p className="mt-1 text-sm text-slate-600">eコンビニで出品中の商品に連携したBELLO在庫</p></div>
      <div className="flex flex-wrap gap-2"><Link href="/inventory/listings" className={button}>EC出品へ戻る</Link><button className={button} disabled={busy || !!pending} onClick={() => void reload()}>{busy ? "処理中…" : "再読込"}</button></div>
    </div>
    {data && <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-2">
      <p>確認日時: {data.checkedAt ? new Date(data.checkedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + "（日本時間）" : "未取得"} · {data.items.length}件</p>
      <p>金額はすべて1点当たり。販売日数は登録された販売開始日を基準に表示。未登録・算出不可の項目は「—」です。</p>
      <p>未連携 {data.unlinkedCount}件 / 連携先を特定できない商品 {data.ambiguousCount}件 <Link href="/inventory/listings" className="underline text-blue-700">eコンビニ連携を確認</Link></p>
      {data.warnings.map((warning, index) => <p key={index} className="text-amber-800">{warning}</p>)}
      {!data.canEdit && <p className="font-medium">閲覧専用です。商品の選択・保存はできません。</p>}
    </div>}
    {message && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">{message}</p>}
    {results.some(result => result.status === "failed" || result.status === "unknown") && <ul className="text-sm text-red-800" aria-label="保存できなかった商品">{results.filter(result => result.status === "failed" || result.status === "unknown").map(result => <li key={result.id}>{data?.items.find(row => row.id === result.id)?.name ?? result.id}: {result.status === "unknown" ? "結果不明" : "失敗"} {result.message}</li>)}</ul>}
    {pending && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm"><p>結果不明の受付があるため、新しい選択・保存・再読込を停止しています。</p><button className={button + " mt-2"} disabled={busy} onClick={() => void save(pending)}>同じ受付内容で結果を確認</button></div>}
    {data && <>
      <div className="flex flex-wrap items-center gap-3 text-sm"><span>選択 {selected.size}件 / 1回最大100件</span><button className={button} disabled={!editable} onClick={() => setSelected(new Set(selectable.slice(0, 100).map(row => row.id)))}>一覧の未設定商品を100件まで選択</button><button className={button} disabled={!editable || !selected.size} onClick={() => setSelected(new Set())}>選択をすべて解除</button></div>
      <p className="text-xs text-slate-500 md:hidden">表を左右にスクロールすると、すべての金額・日数・数量を確認できます。</p>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[920px] text-sm"><caption className="sr-only">出品中の連携在庫。各数値の見出しで昇順・降順を切り替えられます。</caption><thead className="bg-slate-50 text-slate-600"><tr><th className="p-3"><input type="checkbox" className="h-5 w-5" aria-label="一覧の未設定商品を100件まで一括選択・解除" disabled={!editable || !selectable.length} checked={selectable.length > 0 && selectable.slice(0, 100).every(row => selected.has(row.id))} onChange={event => setSelected(event.target.checked ? new Set(selectable.slice(0, 100).map(row => row.id)) : new Set())}/></th><th className="p-3 text-left">商品</th>{columns.map(([key, label]) => <th key={key} className="p-3 text-right" aria-sort={sort.key === key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}><button className="whitespace-nowrap py-2" onClick={() => setSort(previous => ({ key, direction: previous.key === key && previous.direction === "asc" ? "desc" : "asc" }))}>{label} {sort.key === key ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</button></th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.map(row => <tr key={row.id} className={selected.has(row.id) ? "bg-blue-50" : ""}><td className="p-3 align-top"><input type="checkbox" className="h-5 w-5" aria-label={`${row.name}を選択`} checked={selected.has(row.id)} disabled={!editable || row.alreadyWholesale || (!selected.has(row.id) && selected.size >= 100)} onChange={() => toggle(row.id)}/></td><td className="p-3"><div className="flex items-start gap-3">{row.imageUrl ? <img src={row.imageUrl} alt="" width={64} height={64} className="h-16 w-16 shrink-0 rounded-lg object-cover"/> : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs text-slate-500">画像なし</div>}<div className="min-w-0 max-w-lg"><a className="whitespace-normal break-words font-medium text-blue-800 underline" href={`/inventory/${encodeURIComponent(row.id)}`}>{row.name}</a><p className="mt-1 text-xs text-slate-500">{row.displayId}</p>{row.alreadyWholesale && <span className="mt-1 inline-block rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-800">業者間 設定済み</span>}</div></div></td>{columns.map(([key]) => <td key={key} className="whitespace-nowrap p-3 text-right tabular-nums align-top">{number(row[key], key === "purchaseAmount" || key === "shipping" || key === "totalCost")}</td>)}</tr>)}</tbody></table>
        {!rows.length && <p className="p-8 text-center text-sm text-slate-500">対象の出品中商品はありません。</p>}
      </div>
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-lg"><div><p className="font-medium">{selected.size}件を選択中</p><p className="text-xs text-slate-500">「販売中」とほかのカテゴリを保持し、「業者間」を追加します。</p></div><button className="rounded-lg bg-slate-900 px-5 py-3 text-sm font-bold text-white disabled:opacity-40" disabled={!editable || !selected.size} onClick={() => setConfirming(true)}>業者間行きにする</button></div>
    </>}
    {confirming && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div role="dialog" aria-modal="true" aria-labelledby="wholesale-confirm" className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"><h3 id="wholesale-confirm" className="text-lg font-bold">{selected.size}件を業者間行きにしますか？</h3><p className="mt-3 text-sm text-slate-600">既存カテゴリを保持して「業者間」を追加します。出品状態・数量・価格は変更しません。</p><div className="mt-6 flex justify-end gap-2"><button className={button} onClick={() => setConfirming(false)}>キャンセル</button><button className="rounded-lg bg-slate-900 px-4 py-2 text-white" onClick={() => void save()}>この{selected.size}件を保存</button></div></div></div>}
  </div>;
}
