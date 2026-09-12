"use client";

import { useState } from "react";
import { getInventoryHistoryAction } from "@/app/actions/inventory";
import { formatDateTime, historyOperationLabel, historyChangeSummary } from "@/lib/inventory/historyDisplay";
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
}: {
  inventoryId: string;
  initialRows: InventoryHistoryRow[] | null;
}) {
  const [state, setState] = useState<LoadState>(initialRows === null ? { kind: "error" } : { kind: "ok", rows: initialRows });

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
          {state.rows.map((h) => (
            <tr key={h.id} className="border-b border-gray-100 text-gray-700">
              <td className="whitespace-nowrap py-1 px-2 align-top">{formatDateTime(h.changedAt)}</td>
              <td className="whitespace-nowrap py-1 px-2 align-top">{historyOperationLabel(h.fieldName)}</td>
              <td className="py-1 px-2 align-top">{historyChangeSummary(h)}</td>
              <td className="whitespace-nowrap py-1 px-2 align-top">{h.changedBy ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
