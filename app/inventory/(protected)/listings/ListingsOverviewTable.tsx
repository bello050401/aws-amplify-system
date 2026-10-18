"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
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
  type EcCatalog,
  type EcChannel,
  type EcState,
  type EcOperation,
} from "@/lib/listing/ecManagement";
import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { InventoryThumbnail } from "../../InventoryThumbnail";
import { usePrimaryPhotoThumbnails } from "../../usePrimaryPhotoThumbnails";
import { resolveListPhotoUrl } from "@/lib/photoRegistration/gallerySelection";
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
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(0),
    [pageSize, setPageSize] = useState(50),
    [sort, setSort] = useState("updated");
  const [operation, setOperation] = useState<{
      kind: EcOperation;
      items: ListingOverviewRow[];
      channel: EcChannel;
    } | null>(null);
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
    setPage(0);
  }, [query, channel, filter, archived, pageSize, sort]);
  const pagination = paginate(filtered, page, pageSize),
    pageRows = pagination.pageRows;
  const photoThumbnails = usePrimaryPhotoThumbnails(pageRows.map(row => row.inventoryId));
  function open(kind: EcOperation, items: ListingOverviewRow[], target = channel) {
    setOperation({ kind, items, channel: target });
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
          <p className="mt-1 text-xs text-gray-500">各商品の販売先の欄から出品・停止できます。</p>
        </div>
        <div className="flex gap-2">
          <button
            className={button}
            type="button"
            disabled={catalogBusy}
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
          <option value="price">単価が高い順</option>
        </select>
      </div>
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
              <th className="px-3 py-3 text-left">商品</th>
              <th className="hidden px-3 py-3 text-right md:table-cell">数量</th>
              <th className="hidden px-3 py-3 text-right md:table-cell">単価</th>
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
                className="hover:bg-gray-50/70"
              >
                <td className="px-2 py-3 md:px-3">
                  <div className="flex min-w-0 max-w-xl items-start gap-2 md:min-w-64 md:items-center md:gap-3">
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-gray-100 md:h-14 md:w-14">
                      <InventoryThumbnail
                        storageKey={row.thumbnailKey}
                        directUrl={resolveListPhotoUrl(row.thumbnailIsPrimary === true, photoThumbnails[row.inventoryId])}
                        alt={row.name}
                      />
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
                        {row.price != null ? `単価 ${row.price.toLocaleString()}円` : "単価未設定"}
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
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
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
                          {c !== "YAHOO" && s.externalId && <button type="button" aria-label={`${row.name}の${EC_CHANNEL_LABEL[c]}商品内容を更新`} className="rounded border px-2 py-1 text-blue-700 disabled:opacity-30" disabled={s.state==="PENDING"||s.state==="UNKNOWN"} onClick={()=>open("UPDATE",[row],c)}>更新</button>}
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
          onChanged={() => {
            void loadCatalog();
            void listListingsOverviewSafeAction().then((r) => setState(loadStateFromInitialRows(r)));
          }}
        />
      )}
    </div>
  );
}
