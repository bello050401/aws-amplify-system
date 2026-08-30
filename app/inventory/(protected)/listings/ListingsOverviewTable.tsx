"use client";

import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { bulkCreateListingDraftsAction } from "@/app/actions/listing";
import { savePricingAssignmentSelection } from "@/lib/listing/pricingAssignmentSelection";
import type { ListingOverviewRow } from "@/lib/listing/service";
import { InventoryThumbnail } from "../../InventoryThumbnail";

// BELLO統合業務OS指示書(2026-08-30) §14: Listing Status State Machine
// 12値 + このUI独自の"NOT_STARTED"(ChannelListing行がまだ無い商品)。
// state自体の遷移はlib/listing/service.tsだけが行う(§14「UIが直接
// 自由にstatusを変更しない」) — ここは表示のためのラベル/バッジ定義
// のみ。
type StatusFilter = "ALL" | "NOT_STARTED" | Exclude<ListingOverviewRow["channelListing"], null>["status"];

/**
 * 1行の状態を、既存のListingOverviewRow(Inventory + 最大1件のChannelListing)
 * から導出する — spec §16「外部ID/状態の可視化」に対応する唯一のロジ
 * ック(このファイル内で完結、他へは波及しない)。
 */
function statusOf(row: ListingOverviewRow): Exclude<StatusFilter, "ALL"> {
  if (!row.channelListing) return row.hasDraft ? "DRAFT" : "NOT_STARTED";
  return row.channelListing.status;
}

const STATUS_LABEL: Record<StatusFilter, string> = {
  ALL: "すべて",
  NOT_STARTED: "未着手",
  NOT_PREPARED: "未準備",
  DRAFT: "下書き",
  READY: "出品準備完了",
  QUEUED: "出品待ち",
  PUBLISHING: "出品処理中",
  ACTIVE: "出品済み",
  PAUSED: "停止中",
  SOLD: "売却済み",
  ENDED: "終了",
  RELIST_PENDING: "再出品待ち",
  ERROR: "出品失敗",
  ARCHIVED: "アーカイブ済み",
};

const STATUS_BADGE_CLASS: Record<Exclude<StatusFilter, "ALL">, string> = {
  NOT_STARTED: "bg-gray-100 text-gray-500",
  NOT_PREPARED: "bg-gray-100 text-gray-500",
  DRAFT: "bg-amber-50 text-amber-700",
  READY: "bg-amber-50 text-amber-700",
  QUEUED: "bg-blue-50 text-blue-700",
  PUBLISHING: "bg-blue-50 text-blue-700",
  ACTIVE: "bg-green-50 text-green-700",
  PAUSED: "bg-gray-100 text-gray-600",
  SOLD: "bg-green-50 text-green-700",
  ENDED: "bg-gray-100 text-gray-500",
  RELIST_PENDING: "bg-blue-50 text-blue-700",
  ERROR: "bg-red-50 text-red-700",
  ARCHIVED: "bg-gray-100 text-gray-400",
};

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §15/§16 —
 * 一覧ベースのEC出品管理UI本体(商品中心・検索/状態絞り込み・一括操作
 * ・外部ID/状態の可視化・詳細画面への深いリンク、という"コンセプト"の
 * 実装 — UI/デザイン/コードは他社ツールから一切コピーしていない)。
 *
 * この画面が扱う母集団(Inventory全体、既存のSEARCH_MAX_SCAN_ITEMSと
 * 同じ上限)は、このアプリが一貫して採用している「全部読み込んでから
 * クライアント側で絞り込む」規模に収まるため、検索・状態フィルタは
 * サーバー往復なしでこのコンポーネント内だけで完結させている
 * (サーバー側ページングはこの規模には過剰設計 — lib/inventory/queries.ts
 * のSEARCH_MAX_SCAN_ITEMS付近のコメントと同じ判断)。
 */
export function ListingsOverviewTable({ rows, canEdit }: { rows: ListingOverviewRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== "ALL" && statusOf(row) !== statusFilter) return false;
      if (!q) return true;
      return row.name.toLowerCase().includes(q) || row.displayId.toLowerCase().includes(q);
    });
  }, [rows, query, statusFilter]);

  // 一括下書き作成の対象になり得るのは「まだ下書きが無い」商品だけ
  // (既存下書きはsaveListingDraftのupsert仕様上、一括実行すると
  // タイトル/価格が初期値へ巻き戻ってしまうため — lib/listing/service.ts
  // のbulkCreateListingDraftsコメント参照)。
  const selectableIds = useMemo(() => filtered.filter((r) => !r.hasDraft).map((r) => r.inventoryId), [filtered]);
  const allSelectableSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggleOne(inventoryId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(inventoryId)) next.delete(inventoryId);
      else next.add(inventoryId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelectableSelected ? new Set() : new Set(selectableIds));
  }

  /**
   * 第六ラウンド§14: 選択IDはクエリ文字列へ入れず(431再発防止、
   * lib/listing/pricingAssignmentSelection.tsのコメント参照)
   * sessionStorage経由で割当ページへ渡す。
   */
  function goToPricingRuleAssignment() {
    if (selected.size === 0) return;
    savePricingAssignmentSelection(Array.from(selected));
    router.push("/inventory/listings/pricing-rules/assign");
  }

  async function runBulkCreate() {
    if (selected.size === 0) return;
    setBusy(true);
    setResultMessage(null);
    setErrorMessage(null);
    try {
      const result = await bulkCreateListingDraftsAction(Array.from(selected));
      const parts = [`作成: ${result.created.length}件`];
      if (result.skipped.length > 0) parts.push(`スキップ（既に下書きあり）: ${result.skipped.length}件`);
      if (result.failed.length > 0) parts.push(`失敗: ${result.failed.length}件`);
      setResultMessage(parts.join(" / "));
      if (result.failed.length > 0) {
        console.error("[ListingsOverviewTable] bulk create failures:", result.failed);
      }
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "一括作成に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="商品名・在庫IDで絞り込み"
          className="w-64 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
        >
          {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((key) => (
            <option key={key} value={key}>
              {STATUS_LABEL[key]}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-gray-500">{filtered.length.toLocaleString("ja-JP")}件表示</span>

        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 && <span className="text-[12px] text-gray-600">{selected.size}件選択中</span>}
            <button
              type="button"
              onClick={runBulkCreate}
              disabled={busy || selected.size === 0}
              className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
            >
              {busy ? "作成中…" : "選択した商品の出品下書きを一括作成"}
            </button>
            {/* 第六ラウンド§14/§122-124: 自動値下げルールの主導線をEC出品側へ配置。 */}
            <button
              type="button"
              onClick={goToPricingRuleAssignment}
              disabled={busy || selected.size === 0}
              title={selected.size === 0 ? "商品を選択してください" : undefined}
              className="border border-gray-900 px-3 py-1 text-[13px] font-bold text-gray-900 hover:bg-gray-50 disabled:opacity-50"
            >
              自動値下げルールを設定
            </button>
            <Link href="/inventory/listings/pricing-rules" className="text-[12px] text-blue-700 underline">
              ルール一覧を管理
            </Link>
          </div>
        )}
      </div>

      {resultMessage && <p className="mb-2 text-[12px] text-green-700">{resultMessage}</p>}
      {errorMessage && <p className="mb-2 text-[12px] text-red-600">{errorMessage}</p>}

      <div className="overflow-x-auto border border-gray-200">
        <table className="w-full min-w-[900px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] text-gray-500">
              {canEdit && (
                <th className="w-8 px-2 py-2">
                  {/* MasterList.tsxと同じ — チェックボックスの見た目は
                      変えず、labelで包んで当たり判定だけ32px角へ広げる。 */}
                  <label className="inline-flex min-h-8 min-w-8 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={allSelectableSelected}
                      onChange={toggleAll}
                      disabled={selectableIds.length === 0}
                      aria-label="すべて選択"
                    />
                  </label>
                </th>
              )}
              <th className="w-24 px-2 py-2">画像</th>
              <th className="px-2 py-2">商品名 / 在庫ID</th>
              <th className="px-2 py-2">数量</th>
              <th className="px-2 py-2">価格</th>
              <th className="px-2 py-2">状態</th>
              <th className="px-2 py-2">外部ID</th>
              <th className="px-2 py-2">最終更新</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 8 : 7} className="px-2 py-8 text-center text-[12px] text-gray-400">
                  該当する商品がありません。
                </td>
              </tr>
            )}
            {filtered.map((row) => {
              const status = statusOf(row);
              const canSelect = !row.hasDraft;
              return (
                <tr key={row.inventoryId} className="border-b border-gray-100 hover:bg-gray-50">
                  {canEdit && (
                    <td className="px-2 py-2 align-middle">
                      <input
                        type="checkbox"
                        checked={selected.has(row.inventoryId)}
                        onChange={() => toggleOne(row.inventoryId)}
                        disabled={!canSelect}
                        title={canSelect ? undefined : "既に出品下書きがあります"}
                      />
                    </td>
                  )}
                  <td className="px-2 py-2 align-middle">
                    <InventoryThumbnail storageKey={row.thumbnailKey} alt={row.name} size="small" />
                  </td>
                  <td className="px-2 py-2 align-middle">
                    {/* 不具合修正・ZAICO同期重複根絶指示書(2026-08-30)
                        §8: 「詳細」ボタン(旧: 末尾列のリンク)を廃止し、
                        商品タイトルをクリック可能なリンクにする——
                        Linkはネイティブに<a>を描画するのでhover/focus
                        (下線+色)・キーボード操作(Tab+Enter)・
                        aria読み上げ(タイトルがリンクテキスト)を
                        追加コード無しで満たす。既存の行操作
                        (チェックボックス/画像)とは別要素なので干渉しない。 */}
                    <Link href={`/inventory/${row.inventoryId}/listing`} className="font-bold text-gray-900 underline decoration-transparent hover:decoration-gray-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-900">
                      {row.name}
                    </Link>
                    <div className="font-mono text-[11px] text-gray-500">{row.displayId}</div>
                  </td>
                  <td className="px-2 py-2 align-middle">{row.quantity.toLocaleString("ja-JP")}</td>
                  <td className="px-2 py-2 align-middle">{row.price != null ? `¥${row.price.toLocaleString("ja-JP")}` : "-"}</td>
                  <td className="px-2 py-2 align-middle">
                    <span className={`inline-block px-2 py-0.5 text-[11px] font-bold ${STATUS_BADGE_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
                    {status === "ERROR" && row.channelListing?.lastError && (
                      <div className="mt-1 max-w-[220px] truncate text-[11px] text-red-600" title={row.channelListing.lastError}>
                        {row.channelListing.lastError}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 align-middle">
                    {row.channelListing?.externalListingId ? (
                      row.channelListing.listingUrl ? (
                        <a
                          href={row.channelListing.listingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-[11px] text-blue-700 underline"
                        >
                          {row.channelListing.externalListingId}
                        </a>
                      ) : (
                        <span className="font-mono text-[11px] text-gray-700">{row.channelListing.externalListingId}</span>
                      )
                    ) : (
                      <span className="text-gray-300">-</span>
                    )}
                  </td>
                  <td className="px-2 py-2 align-middle text-[11px] text-gray-500">
                    {formatJstDateTime(row.channelListing?.updatedAt ?? row.inventoryUpdatedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
