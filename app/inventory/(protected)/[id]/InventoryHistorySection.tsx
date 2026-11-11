"use client";

import { useState } from "react";
import { getInventoryHistoryAction } from "@/app/actions/inventory";
import { formatDateTime, historyOperationLabel, historyChangeSummary,historyChangeDetails,historyActorLabel,historyQuantity } from "@/lib/inventory/historyDisplay";
import type { InventoryHistoryRow } from "@/lib/inventory/queries";

type LoadState =
  | { kind: "ok"; rows: InventoryHistoryRow[] }
  | { kind: "error" }
  | { kind: "retrying" };

/**
 * 更新履歴の表示本体。局所エラー処理レビュー補正(2026-09-12)——
 * InventoryHistoryTable.tsx(Server Component)がSSR時点で取得を試み、
 * その結果(成功なら行の配列、失敗なら`null`)を`initialRows`として渡す。
 * ここでの責務は3つの状態を明確に描き分けること:
 *   - rows.length === 0 …「変更履歴はまだありません」(=取得できた上での実0件)
 *   - initialRows === null …「取得エラー」+ 再試行ボタン
 *   - rows.length > 0 … 通常のテーブル表示
 * 「データなし」と「取得失敗」を混同しない(仕様の binding要件)。
 *
 * 再試行はServer Action(app/actions/inventory.tsのgetInventoryHistoryAction)
 * 経由——ページ全体を再読み込み/router.refresh()せずに履歴セクション
 * だけをやり直す。本体(基本情報・画像・価格操作)はP1の分離により
 * すでに再試行と無関係に描画済みなので、ここを再試行してもそちらは
 * 一切影響を受けない。SalesItemsSection.tsx(app/inventory/(protected)/
 * sales/)と同じ「Server Actionが`{ok:false}`を返す正常系の失敗」と
 * 「通信そのものがreject/例外を投げる異常系」の両方をcatchで受ける設計。
 */
export function InventoryHistorySection({
  inventoryId,
  initialRows,
  categories=[],locations=[],
}: {
  inventoryId: string;
  initialRows: InventoryHistoryRow[] | null;
  categories?:{id:string;name:string}[];locations?:{id:string;name:string}[];
}) {
  const [state, setState] = useState<LoadState>(initialRows === null ? { kind: "error" } : { kind: "ok", rows: initialRows });
  const [filter,setFilter]=useState('すべて');

  async function retry() {
    setState({ kind: "retrying" });
    try {
      const result = await getInventoryHistoryAction(inventoryId);
      setState(result.ok ? { kind: "ok", rows: result.rows } : { kind: "error" });
    } catch {
      // 通信断ではServer Actionの戻り値を受け取れないため、再試行可能に戻す。
      setState({ kind: "error" });
    }
  }

  if (state.kind === "retrying") {
    return (
      <p className="text-[12px] text-gray-400" aria-live="polite">
        読み込み中…
      </p>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <p className="text-[12px] text-red-600" role="alert">
          変更履歴を読み込めませんでした。
        </p>
        <button
          type="button"
          onClick={() => void retry()}
          className="mt-1 border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
        >
          再試行
        </button>
      </div>
    );
  }

  if (state.rows.length === 0) {
    return <p className="text-[12px] text-gray-400">変更履歴はまだありません。</p>;
  }

  return (
    // BELLO統合業務OS指示書(2026-08-30) §70/§165: 390px幅で
    // 「変更内容」列(自由長テキスト、折り返さない)が原因で
    // page body自体が横スクロールしないよう、この表だけの
    // overflow-x-autoで横スクロールを閉じ込める(§78「body自体は
    // 横スクロールしない」の binding要件 — テーブル自体が幅を
    // 持つのは許容範囲、ページ全体が伸びるのは不可)。
    <div><div className="mb-3 flex flex-wrap gap-2" aria-label="履歴の種類">{['すべて','数量','入庫','出庫'].map(label=><button type="button" key={label} aria-pressed={filter===label} className={'rounded-lg border px-3 py-2 text-sm '+(filter===label?'bg-teal-50 text-teal-900':'bg-white')} onClick={()=>setFilter(label)}>{label}</button>)}</div>
      {filter==='数量'&&<QuantityChart rows={state.rows}/>}
      <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] border-collapse text-[12px]">
        <thead className="text-left text-gray-400">
          <tr className="border-b border-gray-200">
            <th className="py-1 px-2 font-normal">日時</th>
            <th className="py-1 px-2 font-normal">操作</th>
            <th className="py-1 px-2 font-normal">変更内容</th>
            <th className="py-1 px-2 font-normal">実行者</th>
          </tr>
        </thead>
        <tbody>
          {state.rows.filter(h=>filter==='すべて'||filter==='数量'&&historyQuantity(h)!==null||filter!=='数量'&&h.fieldName.includes(filter)).map((h) => (
            <tr key={h.id} className="border-b border-gray-100 text-gray-700">
              <td className="whitespace-nowrap py-1 px-2 align-top">{formatDateTime(h.changedAt)}</td>
              <td className="whitespace-nowrap py-1 px-2 align-top">{historyOperationLabel(h.fieldName)}</td>
              <td className="py-2 px-2 align-top"><HistoryChange row={h} categories={categories} locations={locations}/></td>
              <td className="whitespace-nowrap py-1 px-2 align-top">{historyActorLabel(h.changedBy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div></div>
  );
}
function HistoryChange({row,categories,locations}:{row:InventoryHistoryRow;categories:{id:string;name:string}[];locations:{id:string;name:string}[]}){
 const details=historyChangeDetails(row,{categories,locations}),structured=/^[\[{]/.test(row.oldValue??'')||/^[\[{]/.test(row.newValue??'');
 return <><div className="space-y-1 whitespace-pre-wrap break-words">{details.length?details.map((d,i)=><div key={i}><span className="font-medium">{d.label}</span> <span className="text-gray-500">{d.before}</span> → {d.after}</div>):structured?<span>{row.fieldName}の記録</span>:historyChangeSummary(row)}</div>{structured&&<details className="mt-1 text-gray-500"><summary className="cursor-pointer text-xs">記録詳細</summary><pre className="max-w-xl whitespace-pre-wrap break-all text-xs">{row.oldValue??'未設定'} → {row.newValue??'未設定'}{'\n'}実行者：{row.changedBy??'システム'}</pre></details>}</>;
}
function QuantityChart({rows}:{rows:InventoryHistoryRow[]}){
 const points=rows.map(h=>({value:historyQuantity(h),date:h.changedAt})).filter((p):p is {value:number;date:string}=>p.value!==null).sort((a,b)=>a.date.localeCompare(b.date));
 if(!points.length)return <p className="py-3 text-sm text-gray-500">数量の記録はありません。</p>;
 const max=Math.max(1,...points.map(p=>p.value));return <div className="mb-4 rounded-lg border p-3"><p className="text-sm">記録のある数量の推移（{points.length}件）</p><svg viewBox="0 0 600 120" className="h-28 w-full" role="img" aria-label={'数量の推移。最新'+points.at(-1)!.value+'点'}><polyline fill="none" stroke="#287268" strokeWidth="2" points={points.map((p,i)=>`${10+i*580/Math.max(1,points.length-1)},${110-p.value*100/max}`).join(' ')}/>{points.map((p,i)=><circle key={i} cx={10+i*580/Math.max(1,points.length-1)} cy={110-p.value*100/max} r="3" fill="#287268"><title>{formatDateTime(p.date)}：{p.value}</title></circle>)}</svg><p className="text-xs text-gray-500">{formatDateTime(points[0].date)} ～ {formatDateTime(points.at(-1)!.date)}</p></div>;
}
