"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  bulkCreateListingDraftsAction,
  exportMercariShopsCsvAction,
  listListingsOverviewSafeAction,
} from "@/app/actions/listing";
import { getEcListingCatalogAction } from "@/app/actions/ecListingCatalog";
import type { ListingOverviewRow } from "@/lib/listing/service";
import type { ListingsOverviewLoadOutcome } from "@/lib/listing/overviewFailure";
import {
  loadStateFromInitialRows,
  paginate,
  type ListingsLoadState,
} from "@/lib/listing/listingsOverviewTableLogic";
import {
  EC_CHANNELS,
  EC_CHANNEL_LABEL,
  EC_STATE_LABEL,
  ecStateFor,
  retainVisibleSelection,
  type EcCatalog,
  type EcChannel,
  type EcState,
  type EcOperation,
} from "@/lib/listing/ecManagement";
import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { downloadCsvFromBase64, type MercariCsvExportOutcome } from "./mercariCsvDownload";
import { InventoryThumbnail } from "../../InventoryThumbnail";
import { EcBulkDialog } from "./EcBulkDialog";

const button =
  "rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium hover:bg-gray-50 disabled:opacity-40";
const badge: Record<EcState, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700",
  STOPPED: "bg-gray-100 text-gray-600",
  ENDED: "bg-gray-100 text-gray-500",
  DRAFT: "bg-amber-50 text-amber-700",
  UNLISTED: "bg-gray-100 text-gray-500",
  PENDING: "bg-blue-50 text-blue-700",
  ERROR: "bg-red-50 text-red-700",
  UNKNOWN: "bg-gray-100 text-gray-500",
};
const EMPTY: ListingOverviewRow[] = [];
export function ListingsOverviewTable({
  initialResult,
  canEdit,
}: {
  initialResult: ListingsOverviewLoadOutcome<ListingOverviewRow>;
  canEdit: boolean;
}) {
  const [state, setState] = useState<ListingsLoadState<ListingOverviewRow>>(() =>
    loadStateFromInitialRows(initialResult),
  );
  const [catalog, setCatalog] = useState<EcCatalog | null>(null),
    [catalogBusy, setCatalogBusy] = useState(false);
  const [channel, setChannel] = useState<EcChannel>("MERCARI_SHOPS"),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState<"ALL" | EcState>("ALL");
  const [archived, setArchived] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0),
    [pageSize, setPageSize] = useState(50),
    [sort, setSort] = useState("updated");
  const [operation, setOperation] = useState<{
      kind: EcOperation;
      items: ListingOverviewRow[];
      channel: EcChannel;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState("");
  const [csv, setCsv] = useState<MercariCsvExportOutcome | null>(null);
  const authRetry = useRef(false);
  useEffect(() => setState(loadStateFromInitialRows(initialResult)), [initialResult]);
  async function loadCatalog() {
    setCatalogBusy(true);
    try {
      setCatalog(await getEcListingCatalogAction());
    } catch {
      setCatalog({
        channels: {},
        archivedIds: [],
        errors: ["販売先の状態を読み込めませんでした。再読込してください。"],
      });
    } finally {
      setCatalogBusy(false);
    }
  }
  useEffect(() => {
    void loadCatalog();
  }, []);
  async function reload() {
    setState({ kind: "retrying" });
    await loadCatalog();
    try {
      setState(loadStateFromInitialRows(await listListingsOverviewSafeAction()));
    } catch {
      setState({ kind: "error", failure: { stage: null, kind: "unknown" } });
    }
  }
  useEffect(() => {
    if (state.kind === "error" && state.failure.kind === "auth-expired" && !authRetry.current) {
      authRetry.current = true;
      void reload();
    }
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = state.kind === "ok" ? state.rows : EMPTY;
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ja-JP"),
      deleted = new Set(catalog?.archivedIds ?? []);
    return rows
      .filter((row) => deleted.has(row.inventoryId) === archived)
      .filter(
        (row) =>
          filter === "ALL" || ecStateFor(catalog, channel, row.inventoryId, row.hasDraft).state === filter,
      )
      .filter(
        (row) =>
          !q ||
          [
            row.name,
            row.displayId,
            ...EC_CHANNELS.map((c) => ecStateFor(catalog, c, row.inventoryId, row.hasDraft).externalId ?? ""),
          ].some((s) => s.toLocaleLowerCase("ja-JP").includes(q)),
      )
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name, "ja")
          : sort === "quantity"
            ? b.quantity - a.quantity
            : sort === "price"
              ? (b.price ?? 0) - (a.price ?? 0)
              : b.inventoryUpdatedAt.localeCompare(a.inventoryUpdatedAt),
      );
  }, [rows, catalog, query, channel, filter, sort, archived]);
  useEffect(() => {
    if (state.kind !== "ok" || catalogBusy) return;
    setSelected((s) =>
      retainVisibleSelection(
        s,
        filtered.map((r) => r.inventoryId),
      ),
    );
  }, [filtered, state.kind, catalogBusy]);
  useEffect(() => {
    setPage(0);
  }, [query, channel, filter, archived, pageSize, sort]);
  const pagination = paginate(filtered, page, pageSize),
    pageRows = pagination.pageRows;
  const picked = rows.filter((row) => selected.has(row.inventoryId));
  const allPage = pageRows.length > 0 && pageRows.every((r) => selected.has(r.inventoryId));
  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function togglePage() {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of pageRows) allPage ? next.delete(row.inventoryId) : next.add(row.inventoryId);
      return next;
    });
  }
  function open(kind: EcOperation, items = picked, target = channel) {
    setOperation({ kind, items, channel: target });
  }
  async function createDrafts() {
    if (!selected.size || busy) return;
    setBusy(true);
    setFeedback("");
    try {
      const r = await bulkCreateListingDraftsAction([...selected]);
      setFeedback(
        `下書き作成 ${r.created.length}件 · 作成済み ${r.skipped.length}件 · 失敗 ${r.failed.length}件`,
      );
      await reload();
    } catch {
      setFeedback("下書きを作成できませんでした。選択は保持されています。");
    } finally {
      setBusy(false);
    }
  }
  async function exportCsv() {
    if (!selected.size || busy) return;
    setBusy(true);
    setCsv(null);
    try {
      const r = await exportMercariShopsCsvAction([...selected]);
      setCsv(r);
      if (r.ok && r.csvBase64 && r.filename) downloadCsvFromBase64(r.csvBase64, r.filename);
    } catch {
      setFeedback("CSVを作成できませんでした。選択は保持されています。");
    } finally {
      setBusy(false);
    }
  }
  if (state.kind !== "ok")
    return (
      <div className="rounded-lg border p-5 text-sm" role="status">
        {state.kind === "retrying" ? (
          "商品一覧を読み込み中…"
        ) : (
          <>
            <p>
              {state.failure.kind === "auth-expired"
                ? "認証の有効期限が切れている可能性があります。再接続してください。"
                : state.failure.kind === "auth-forbidden"
                  ? "この一覧を表示する権限が確認できませんでした。"
                  : "EC出品一覧を読み込めませんでした。"}
            </p>
            <button type="button" onClick={() => void reload()} className={button + " mt-3"}>
              再読込
            </button>
            {state.failure.kind === "auth-expired" && (
              <Link className="ml-3 text-blue-700 underline" href="/inventory/login">
                ログイン画面へ
              </Link>
            )}
          </>
        )}
      </div>
    );
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-gray-900">商品一覧</h2>
          <p className="mt-1 text-xs text-gray-500">商品を選択して、販売先ごとに出品・停止できます。</p>
        </div>
        <div className="flex gap-2">
          <button
            className={button}
            type="button"
            disabled={busy || catalogBusy}
            onClick={() => void reload()}
          >
            再読込
          </button>
          <Link href="/inventory/settings?tab=ecListing" className={button}>
            ⚙ 出品設定
          </Link>
        </div>
      </div>
      <div
        role="tablist"
        aria-label="操作する販売先"
        className="flex gap-1 overflow-x-auto border-b border-gray-200"
      >
        {EC_CHANNELS.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={channel === c}
            onClick={() => {
              setChannel(c);
              setSelected(new Set());
              setFilter("ALL");
            }}
            className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm ${channel === c ? "border-blue-700 font-bold text-blue-800" : "border-transparent text-gray-500 hover:text-gray-900"}`}
          >
            {EC_CHANNEL_LABEL[c]}
          </button>
        ))}
      </div>
      <div className="my-3 flex flex-wrap items-center gap-2">
        <input
          aria-label="商品を検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="商品名・管理番号・出品番号を検索"
          className="min-w-48 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <select
          aria-label="出品状態"
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          className={button}
        >
          <option value="ALL">すべての出品状態</option>
          {Object.entries(EC_STATE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select aria-label="並び順" value={sort} onChange={(e) => setSort(e.target.value)} className={button}>
          <option value="updated">更新が新しい順</option>
          <option value="name">商品名順</option>
          <option value="quantity">数量が多い順</option>
          <option value="price">価格が高い順</option>
        </select>
      </div>
      {canEdit && (
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/95 px-3 py-3 shadow-sm">
          <span className="mr-2 text-sm font-semibold">{selected.size}件選択</span>
          {archived ? (
            <button className={button} disabled={!selected.size || busy} onClick={() => open("RESTORE")}>
              復元
            </button>
          ) : (
            <>
              <button
                className="rounded-md bg-blue-700 px-5 py-2 text-sm font-bold text-white disabled:opacity-40"
                disabled={!selected.size || busy || !catalog?.channels[channel]}
                onClick={() => open("PUBLISH")}
              >
                {EC_CHANNEL_LABEL[channel]}に出品
              </button>
              <button
                className={button}
                disabled={!selected.size || busy || !catalog?.channels[channel]}
                onClick={() => open("STOP")}
              >
                出品停止
              </button>
              <button
                className={button + " text-red-700"}
                disabled={!selected.size || busy}
                onClick={() => open("ARCHIVE")}
              >
                削除
              </button>
              <details className="relative">
                <summary className={button + " cursor-pointer list-none"}>その他 ▾</summary>
                <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border bg-white p-2 shadow-lg">
                  <button
                    className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-40"
                    disabled={!selected.size || busy}
                    onClick={() => void createDrafts()}
                  >
                    共通下書きを一括作成
                  </button>
                  <button
                    className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-40"
                    disabled={!selected.size || busy}
                    onClick={() => void exportCsv()}
                  >
                    メルカリShops CSV出力
                  </button>
                  <Link href="/inventory/listings/pricing-rules" className="block px-3 py-2 text-sm">
                    自動値下げルール
                  </Link>
                </div>
              </details>
            </>
          )}
          <button
            type="button"
            className="ml-auto px-2 text-xs text-gray-600 underline"
            disabled={!selected.size}
            onClick={() => setSelected(new Set())}
          >
            選択解除
          </button>
        </div>
      )}
      {feedback && (
        <p role="status" className="mb-3 text-sm">
          {feedback}
        </p>
      )}
      {csv && (
        <div className="mb-3 rounded border p-3 text-sm">
          {csv.ok ? (
            `CSVを生成しました（${csv.outputCount}件）。`
          ) : (
            <>
              <p>CSVに不足項目があります。</p>
              {csv.blockedRows.map((r, i) => (
                <pre key={i} className="mt-1 whitespace-pre-wrap text-xs">
                  {JSON.stringify(r)}
                </pre>
              ))}
              {csv.encodingErrors?.map((e, i) => (
                <p key={i}>{String(e)}</p>
              ))}
            </>
          )}
        </div>
      )}
      {catalog?.errors.map((e) => (
        <p key={e} role="alert" className="mb-2 text-xs text-red-700">
          {e}
        </p>
      ))}
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-gray-600">
        <span>{filtered.length.toLocaleString()}件</span>
        <span>
          {catalogBusy ? "出品状態を読み込み中…" : "保存済みの出品状態を表示 · 実行時に販売先を再確認"}
        </span>
        <button
          type="button"
          className="ml-auto underline"
          onClick={() => {
            setArchived((v) => !v);
            setSelected(new Set());
          }}
        >
          {archived ? "通常の商品一覧へ" : "削除済み"}
        </button>
        <select
          aria-label="1ページの表示件数"
          className="rounded border bg-white px-2 py-1"
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
        >
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>
              {n}件表示
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full border-collapse text-sm md:min-w-[850px]">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              {canEdit && (
                <th className="w-8 p-2 md:w-10 md:p-3">
                  <input
                    aria-label="このページの商品をすべて選択"
                    type="checkbox"
                    checked={allPage}
                    onChange={togglePage}
                  />
                </th>
              )}
              <th className="px-3 py-3 text-left">商品</th>
              <th className="hidden px-3 py-3 text-right md:table-cell">数量</th>
              <th className="hidden px-3 py-3 text-right md:table-cell">価格</th>
              {EC_CHANNELS.map((c) => (
                <th
                  key={c}
                  className={`w-28 px-2 py-3 text-left md:w-36 md:px-3 ${c === channel ? "bg-blue-50 text-blue-800" : "hidden md:table-cell"}`}
                >
                  {EC_CHANNEL_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pageRows.map((row) => (
              <tr
                key={row.inventoryId}
                className={selected.has(row.inventoryId) ? "bg-blue-50/50" : "hover:bg-gray-50/70"}
              >
                {canEdit && (
                  <td className="p-2 align-middle md:p-3">
                    <input
                      aria-label={`${row.name}を選択`}
                      type="checkbox"
                      checked={selected.has(row.inventoryId)}
                      onChange={() => toggle(row.inventoryId)}
                    />
                  </td>
                )}
                <td className="px-2 py-3 md:px-3">
                  <div className="flex min-w-0 max-w-xl items-start gap-2 md:min-w-64 md:items-center md:gap-3">
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-gray-100 md:h-14 md:w-14">
                      <InventoryThumbnail storageKey={row.thumbnailKey} alt={row.name} />
                    </div>
                    <div className="min-w-0">
                      <Link
                        href={`/inventory/${row.inventoryId}/listing?channel=${channel}`}
                        className="line-clamp-2 font-medium leading-5 text-gray-900 hover:text-blue-700"
                      >
                        {row.name}
                      </Link>
                      <p className="mt-1 text-xs text-gray-600 md:hidden">
                        数量 {row.quantity} ·{" "}
                        {row.price != null ? `${row.price.toLocaleString()}円` : "価格未設定"}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 whitespace-nowrap text-[11px] text-gray-400">
                        <span className="hidden md:inline">{row.displayId}</span>
                        <span className="hidden md:inline">{formatJstDateTime(row.inventoryUpdatedAt)}</span>
                        <Link className="text-blue-700" href={`/inventory/${row.inventoryId}/listing`}>
                          編集
                        </Link>
                        {canEdit && (
                          <button
                            type="button"
                            className="px-1 py-1 text-red-700 hover:underline"
                            onClick={() => open(archived ? "RESTORE" : "ARCHIVE", [row])}
                          >
                            {archived ? "復元" : "削除"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="hidden px-3 py-3 text-right tabular-nums md:table-cell">{row.quantity}</td>
                <td className="hidden whitespace-nowrap px-3 py-3 text-right tabular-nums md:table-cell">
                  {row.price != null ? `${row.price.toLocaleString()}円` : "—"}
                </td>
                {EC_CHANNELS.map((c) => {
                  const s = ecStateFor(catalog, c, row.inventoryId, row.hasDraft);
                  return (
                    <td
                      key={c}
                      className={`px-2 py-3 md:px-3 ${c === channel ? "" : "hidden md:table-cell"}`}
                    >
                      <span
                        className={`inline-block rounded px-2 py-1 text-xs font-medium ${badge[s.state]}`}
                      >
                        {EC_STATE_LABEL[s.state]}
                      </span>
                      {canEdit && !archived && (
                        <div className="mt-1 flex items-center gap-2 text-xs">
                          <button
                            type="button"
                            aria-label={`${row.name}を${EC_CHANNEL_LABEL[c]}に出品`}
                            disabled={s.state === "ACTIVE" || s.state === "UNKNOWN" || s.state === "PENDING"}
                            className="rounded border border-blue-200 px-2 py-1 text-blue-700 hover:bg-blue-50 disabled:opacity-30"
                            onClick={() => open("PUBLISH", [row], c)}
                          >
                            出品
                          </button>
                          <button
                            type="button"
                            aria-label={`${row.name}の${EC_CHANNEL_LABEL[c]}出品を停止`}
                            disabled={!["ACTIVE", "ERROR"].includes(s.state)}
                            className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-100 disabled:opacity-30"
                            onClick={() => open("STOP", [row], c)}
                          >
                            停止
                          </button>
                        </div>
                      )}
                      {s.externalId && (
                        <div className="mt-1 max-w-32 truncate text-[10px] text-gray-500">
                          {s.url ? (
                            <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">
                              {s.externalId} ↗
                            </a>
                          ) : (
                            s.externalId
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!pageRows.length && (
          <p className="p-8 text-center text-sm text-gray-500">
            {archived ? "削除済みの商品はありません。" : "該当する商品はありません。"}
          </p>
        )}
      </div>
      <div className="mt-3 flex items-center justify-end gap-3 text-sm">
        <button
          className={button}
          disabled={pagination.page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          前へ
        </button>
        <span>
          {pagination.page + 1} / {Math.max(1, pagination.pageCount)}
        </span>
        <button
          className={button}
          disabled={pagination.page + 1 >= pagination.pageCount}
          onClick={() => setPage((p) => p + 1)}
        >
          次へ
        </button>
      </div>
      {operation && (
        <EcBulkDialog
          items={operation.items}
          channel={operation.channel}
          operation={operation.kind}
          onClose={() => setOperation(null)}
          onChanged={(done) => {
            setSelected((s) => new Set([...s].filter((id) => !done.includes(id))));
            void loadCatalog();
            void listListingsOverviewSafeAction().then((r) => setState(loadStateFromInitialRows(r)));
          }}
        />
      )}
    </div>
  );
}
