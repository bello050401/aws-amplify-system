"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { listListingsOverviewSafeAction } from "@/app/actions/listing";
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
  retainVisibleSelection,
  type EcCatalog,
  type EcChannel,
  type EcState,
  type EcOperation,
} from "@/lib/listing/ecManagement";
import {
  overviewItems,
  overviewChannel,
  isProtectedSale,
  isSoldInventory,
  matchesListingState,
  categoryMatches,
  type ListingStateFilter,
} from "@/lib/listing/overviewCatalogModel";
import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { InventoryThumbnail } from "../../InventoryThumbnail";
import { usePrimaryPhotoThumbnails } from "../../usePrimaryPhotoThumbnails";
import { resolveListPhotoUrl } from "@/lib/photoRegistration/gallerySelection";
import {
  compareEcOverview,
  ecOverviewPrice,
  type EcSortKey,
} from "@/lib/listing/overviewPresentation";
import { EcBulkDialog, type EcDialogAction } from "./EcBulkDialog";
import { EconveniManualDialog } from "./EconveniManualDialog";
import { econveniManualSyncAction } from "@/app/actions/econveniManualSync";

const button =
  "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40";
const field =
  "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800";
const badge: Record<EcState, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  STOPPED: "bg-slate-200 text-slate-700",
  ENDED: "bg-slate-100 text-slate-600",
  DRAFT: "bg-slate-100 text-slate-600",
  UNLISTED: "bg-slate-100 text-slate-600",
  PENDING: "bg-blue-100 text-blue-800",
  ERROR: "bg-amber-100 text-amber-900",
  UNKNOWN: "bg-slate-100 text-slate-600",
};
const EMPTY: ListingOverviewRow[] = [];
export function ListingsOverviewTable({
  initialResult,
  canEdit,
}: {
  initialResult: ListingsOverviewLoadOutcome<ListingOverviewRow>;
  canEdit: boolean;
}) {
  const [state, setState] = useState<ListingsLoadState<ListingOverviewRow>>(
    () => loadStateFromInitialRows(initialResult),
  );
  const [catalog, setCatalog] = useState<EcCatalog | null>(null),
    [catalogBusy, setCatalogBusy] = useState(false);
  const [source, setSource] = useState<"ECONVENI" | "BELLO">("ECONVENI");
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState<ListingStateFilter>("ALL"),
    [filterChannel, setFilterChannel] = useState<EcChannel | "ALL">("ALL");
  const [categoryFilter, setCategoryFilter] = useState("ALL"),
    [archived, setArchived] = useState(false);
  const [sort, setSort] = useState("ECONVENI"),
    [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0),
    [pageSize, setPageSize] = useState(50);
  const [operation, setOperation] = useState<{
    action: EcDialogAction;
    items: ListingOverviewRow[];
  } | null>(null);
  const [manualOpen, setManualOpen] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [bulkChannel, setBulkChannel] = useState<EcChannel>("BASE");
  const authRetry = useRef(false);
  useEffect(
    () => setState(loadStateFromInitialRows(initialResult)),
    [initialResult],
  );
  async function loadCatalog() {
    setCatalogBusy(true);
    try {
      setCatalog(await getEcListingCatalogAction());
    } catch {
      setCatalog({
        channels: {},
        archivedIds: [],
        errors: ["出品状態を読み込めませんでした。再読込してください。"],
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
    await Promise.all([
      loadCatalog(),
      listListingsOverviewSafeAction()
        .then((r) => setState(loadStateFromInitialRows(r)))
        .catch(() =>
          setState({
            kind: "error",
            failure: { stage: null, kind: "unknown" },
          }),
        ),
    ]);
  }
  useEffect(() => {
    if (
      state.kind === "error" &&
      state.failure.kind === "auth-expired" &&
      !authRetry.current
    ) {
      authRetry.current = true;
      void reload();
    }
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = state.kind === "ok" ? state.rows : EMPTY;
  const all = useMemo(
    () => overviewItems(rows, catalog, source),
    [rows, catalog, source],
  );
  const filtered = useMemo(() => {
    const q = query.normalize("NFKC").trim().toLocaleLowerCase("ja-JP");
    const result = all
      .filter(
        (item) => source === "ECONVENI" || !!item.row?.archived === archived,
      )
      .filter((item) => categoryMatches(item.row, categoryFilter))
      .filter((item) =>
        matchesListingState(item, catalog, filterChannel, filter),
      )
      .filter(
        (item) =>
          !q ||
          [
            item.row?.name,
            item.row?.displayId,
            item.remote?.title,
            item.remote?.productId,
            ...EC_CHANNELS.map(
              (c) => overviewChannel(item, catalog, c).externalId,
            ),
          ].some((v) =>
            v?.normalize("NFKC").toLocaleLowerCase("ja-JP").includes(q),
          ),
      );
    if (sort !== "ECONVENI")
      result.sort((a, b) =>
        a.row && b.row
          ? compareEcOverview(a.row, b.row, sort as EcSortKey, direction)
          : a.row
            ? -1
            : b.row
              ? 1
              : 0,
      );
    return result;
  }, [
    all,
    source,
    archived,
    query,
    categoryFilter,
    catalog,
    filterChannel,
    filter,
    sort,
    direction,
  ]);
  useEffect(
    () =>
      setSelected((s) =>
        retainVisibleSelection(
          s,
          filtered.flatMap((i) => (i.row ? [i.row.inventoryId] : [])),
        ),
      ),
    [filtered],
  );
  useEffect(() => {
    setPage(0);
    setSelected(new Set());
  }, [
    query,
    filter,
    filterChannel,
    source,
    archived,
    pageSize,
    sort,
    categoryFilter,
    direction,
  ]);
  const pagination = paginate(filtered, page, pageSize),
    pageItems = pagination.pageRows;
  const photoThumbnails = usePrimaryPhotoThumbnails(
    pageItems.flatMap((i) => (i.row ? [i.row.inventoryId] : [])),
  );
  const checkedRows = filtered.flatMap((i) =>
    i.row && selected.has(i.row.inventoryId) ? [i.row] : [],
  );
  const selectable = pageItems.flatMap((i) => (i.row ? [i.row] : []));
  const actionsReady = !!catalog && !catalogBusy && !catalog.errors.length;
  function open(
    kind: EcOperation,
    items: ListingOverviewRow[],
    channel: EcChannel = "MERCARI_SHOPS",
  ) {
    setOperation({ action: { kind, channel }, items });
  }
  if (state.kind !== "ok")
    return (
      <div className="rounded-xl border bg-white p-6" role="status">
        {state.kind === "retrying" ? (
          "商品一覧を読み込み中…"
        ) : (
          <>
            <p>
              {state.failure.kind === "auth-expired"
                ? "ログイン状態を確認してください。"
                : "商品一覧を読み込めませんでした。"}
            </p>
            <button className={button + " mt-4"} onClick={() => void reload()}>
              再読込
            </button>
            {state.failure.kind === "auth-expired" && (
              <Link className="ml-4 underline" href="/inventory/login">
                ログインへ
              </Link>
            )}
          </>
        )}
      </div>
    );
  return (
    <div className="mx-auto max-w-[1600px] space-y-4 text-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">EC商品一覧</h2>
          <p className="mt-1 text-sm text-slate-500">
            商品の状態を確認して、販売先ごとに操作できます。
          </p>
        </div>
        <div className="flex gap-2">
          {canEdit && (
            <button className={button} onClick={() => setManualOpen(true)}>
              eコンビニ連携
            </button>
          )}
          <button
            className={button}
            disabled={catalogBusy}
            onClick={() => void reload()}
          >
            {catalogBusy ? "読込中…" : "再読込"}
          </button>
          <Link href="/inventory/settings?tab=ecListing" className={button}>
            出品設定
          </Link>
        </div>
      </div>
      <div
        className="flex items-center gap-6 border-b border-slate-200"
        aria-label="一覧の対象"
      >
        {(["ECONVENI", "BELLO"] as const).map((s) => (
          <button
            key={s}
            className={
              "border-b-2 px-1 pb-3 text-sm font-semibold " +
              (source === s
                ? "border-teal-800 text-teal-900"
                : "border-transparent text-slate-500")
            }
            aria-pressed={source === s}
            onClick={() => {
              setSource(s);
              setArchived(false);
              setSort(s === "ECONVENI" ? "ECONVENI" : "updated");
              setCategoryFilter("ALL");
            }}
          >
            {s === "ECONVENI" ? "eコンビニの商品" : "BELLOの商品"}
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs">
              {s === "ECONVENI"
                ? (catalog?.econveni?.products.length ?? "—")
                : rows.filter((r) => !r.archived).length}
            </span>
          </button>
        ))}
      </div>
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
        <input
          className={field + " w-full"}
          aria-label="商品を検索"
          placeholder="商品名・管理番号で検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="BELLOカテゴリで絞り込み"
        >
          <span className="mr-2 text-xs font-semibold text-slate-500">
            在庫カテゴリ
          </span>
          {[
            "ALL",
            "補修待ち",
            "撮影待ち",
            "出品待ち",
            "販売中",
            "売り切れ",
            ...(source === "ECONVENI" ? ["UNLINKED"] : []),
          ].map((c) => (
            <button
              key={c}
              className={
                "rounded-full border px-3 py-1.5 text-sm " +
                (categoryFilter === c
                  ? "border-teal-800 bg-teal-800 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
              }
              aria-pressed={categoryFilter === c}
              onClick={() => setCategoryFilter(c)}
            >
              {c === "ALL" ? "すべて" : c === "UNLINKED" ? "未連携" : c}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
          <label className="text-xs text-slate-500">
            販売先
            <select
              className={field + " mt-1 block"}
              aria-label="絞り込む販売先"
              value={filterChannel}
              onChange={(e) =>
                setFilterChannel(e.target.value as EcChannel | "ALL")
              }
            >
              <option value="ALL">すべての販売先</option>
              {EC_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {EC_CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            ECの出品状態
            <select
              className={field + " mt-1 block"}
              aria-label="ECの出品状態"
              value={filter}
              onChange={(e) => setFilter(e.target.value as ListingStateFilter)}
            >
              <option value="ALL">すべて</option>
              <option value="ACTIVE">
                {filterChannel === "ALL" ? "いずれかで出品中" : "出品中"}
              </option>
              <option value="INACTIVE">
                {filterChannel === "ALL"
                  ? "全販売先で出品なし"
                  : "出品なし（停止・未出品・終了）"}
              </option>
              <option value="ATTENTION">確認が必要</option>
            </select>
          </label>
          <label className="ml-auto text-xs text-slate-500">
            並び順
            <select
              className={field + " mt-1 block"}
              aria-label="並び順"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              {source === "ECONVENI" && (
                <option value="ECONVENI">eコンビニと同じ順</option>
              )}
              <option value="updated">更新日時</option>
              <option value="created">登録日時</option>
              <option value="name">商品名</option>
              <option value="quantity">在庫数</option>
              <option value="price">基準価格</option>
              {EC_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {EC_CHANNEL_LABEL[c]}の価格
                </option>
              ))}
            </select>
          </label>
          {sort !== "ECONVENI" && (
            <button
              className={button + " h-10"}
              aria-label="昇順・降順を切り替え"
              onClick={() =>
                setDirection((d) => (d === "desc" ? "asc" : "desc"))
              }
            >
              {direction === "desc" ? "↓ 降順" : "↑ 昇順"}
            </button>
          )}
        </div>
      </div>
      {catalog?.errors.map((e) => (
        <p
          key={e}
          role="alert"
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
        >
          {e}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <strong>{filtered.length.toLocaleString()}件</strong>
        <span className="text-xs text-slate-500">
          {catalogBusy
            ? "出品状態を読み込み中…"
            : catalog?.econveni
              ? "eコンビニ 最終取得 " +
                formatJstDateTime(catalog.econveni.checkedAt)
              : "保存済みの出品状態"}
        </span>
        <div className="ml-auto flex items-center gap-3">
          {source === "BELLO" && (
            <button
              className="text-xs text-slate-500 underline"
              onClick={() => setArchived((v) => !v)}
            >
              {archived ? "通常の商品へ" : "削除済み"}
            </button>
          )}
          <select
            className={field}
            aria-label="1ページの表示件数"
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
      </div>
      {canEdit && selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-xl border border-teal-200 bg-teal-50 p-3"
          aria-label="選択商品の一括操作"
        >
          <strong>{selected.size}件 選択中</strong>
          <button className={button} onClick={() => setSelected(new Set())}>
            選択解除
          </button>
          <label className="text-sm">
            操作する販売先{" "}
            <select
              className={field}
              value={bulkChannel}
              onChange={(e) => setBulkChannel(e.target.value as EcChannel)}
            >
              {EC_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {EC_CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <button
            className={button}
            disabled={
              selected.size > 10 ||
              !actionsReady ||
              checkedRows.some((r) => isSoldInventory(r) || r.quantity < 1) ||
              filtered.some(
                (i) =>
                  i.row &&
                  selected.has(i.row.inventoryId) &&
                  isProtectedSale(i, catalog, bulkChannel),
              )
            }
            onClick={() => open("PUBLISH", checkedRows, bulkChannel)}
          >
            出品
          </button>
          <button
            className={button}
            disabled={
              selected.size > 10 ||
              !actionsReady ||
              filtered.some(
                (i) =>
                  i.row &&
                  selected.has(i.row.inventoryId) &&
                  isProtectedSale(i, catalog, bulkChannel),
              )
            }
            onClick={() => open("STOP", checkedRows, bulkChannel)}
          >
            出品を停止
          </button>
          <span className="text-xs text-slate-500">
            1回10件まで・実行前に確認
          </span>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[1120px] table-fixed border-collapse text-sm">
          <colgroup>
            {canEdit && !archived && <col className="w-10" />}
            <col />
            <col className="w-[110px]" />
            <col className="w-[110px]" />
            {EC_CHANNELS.map((c) => (
              <col key={c} className="w-[180px]" />
            ))}
          </colgroup>
          <thead className="border-b bg-slate-50 text-xs text-slate-500">
            <tr>
              {canEdit && !archived && (
                <th className="px-3 py-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    aria-label="このページの商品をすべて選択"
                    checked={
                      selectable.length > 0 &&
                      selectable.every((r) => selected.has(r.inventoryId))
                    }
                    disabled={!selectable.length}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        selectable.forEach((r) =>
                          e.target.checked
                            ? n.add(r.inventoryId)
                            : n.delete(r.inventoryId),
                        );
                        return n;
                      })
                    }
                  />
                </th>
              )}
              <th className="px-4 py-3 text-left">商品</th>
              <th className="px-3 py-3 text-right">在庫・基準価格</th>
              <th className="px-2 py-3 text-center">共通動作</th>
              {EC_CHANNELS.map((c) => (
                <th
                  key={c}
                  className="border-l border-slate-200 px-4 py-3 text-left"
                >
                  {EC_CHANNEL_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {pageItems.map((item) => {
              const row = item.row,
                title = item.remote?.title ?? row?.name ?? "",
                sold = isSoldInventory(row),
                available = sold ? 0 : row?.quantity;
              return (
                <tr
                  key={item.key}
                  className={
                    row && selected.has(row.inventoryId)
                      ? "bg-teal-50/40"
                      : "hover:bg-slate-50/50"
                  }
                >
                  {canEdit && !archived && (
                    <td className="px-3 py-4 align-top">
                      <input
                        className="mt-1 h-4 w-4"
                        type="checkbox"
                        aria-label={title + "を一括操作の対象に選択"}
                        disabled={!row}
                        checked={!!row && selected.has(row.inventoryId)}
                        onChange={(e) =>
                          row &&
                          setSelected((s) => {
                            const n = new Set(s);
                            e.target.checked
                              ? n.add(row.inventoryId)
                              : n.delete(row.inventoryId);
                            return n;
                          })
                        }
                      />
                    </td>
                  )}
                  <td className="px-4 py-5 align-top">
                    <div className="flex gap-4">
                      <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-100 bg-slate-50 [&_img]:!h-full [&_img]:!w-full [&_img]:!object-contain [&_div]:!h-full [&_div]:!w-full">
                        {item.remote?.imageUrl ? (
                          <img
                            src={item.remote.imageUrl}
                            alt={title}
                            className="h-full w-full object-contain"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : row ? (
                          <InventoryThumbnail
                            storageKey={row.thumbnailKey}
                            directUrl={resolveListPhotoUrl(
                              !!row.thumbnailIsPrimary,
                              photoThumbnails[row.inventoryId],
                            )}
                            alt={title}
                            size="list"
                          />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {row?.categories?.map((c) => (
                            <span
                              key={c}
                              className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                            >
                              {c}
                            </span>
                          ))}
                          {!row && (
                            <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                              {item.ambiguous ? "紐付けを確認" : "BELLO未連携"}
                            </span>
                          )}
                        </div>
                        {row ? (
                          <Link
                            href={"/inventory/" + row.inventoryId + "/listing"}
                            className="line-clamp-3 text-base font-semibold leading-6 text-slate-900 hover:underline"
                          >
                            {title}
                          </Link>
                        ) : (
                          <p className="line-clamp-3 text-base font-semibold leading-6">
                            {title}
                          </p>
                        )}
                        <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
                          {row ? (
                            <>
                              <Link
                                href={
                                  "/inventory/" + row.inventoryId + "/listing"
                                }
                                className="font-medium text-teal-800 hover:underline"
                              >
                                商品を編集
                              </Link>
                              <details>
                                <summary className="cursor-pointer">
                                  その他
                                </summary>
                                <div className="mt-2 space-y-2">
                                  <p>{row.displayId}</p>
                                  <p>
                                    更新{" "}
                                    {formatJstDateTime(row.inventoryUpdatedAt)}
                                  </p>
                                  {item.remote &&
                                    item.remote.title !== row.name && (
                                      <p className="whitespace-normal">
                                        在庫名：{row.name}
                                      </p>
                                    )}
                                  {canEdit && (
                                    <button
                                      className="text-red-700 underline"
                                      onClick={() =>
                                        open(archived ? "RESTORE" : "ARCHIVE", [
                                          row,
                                        ])
                                      }
                                    >
                                      {archived ? "復元" : "一覧から削除"}
                                    </button>
                                  )}
                                </div>
                              </details>
                            </>
                          ) : (
                            canEdit && (
                              <button
                                className={button}
                                onClick={() => setManualOpen(true)}
                              >
                                紐付ける
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-5 text-right align-top">
                    <p className="text-lg font-semibold tabular-nums">
                      {row ? available : item.remote?.quantity}
                      <span className="ml-1 text-xs font-normal text-slate-500">
                        点
                      </span>
                    </p>
                    {!row && (
                      <p className="text-[11px] text-slate-500">
                        eコンビニ数量
                      </p>
                    )}
                    <p className="mt-2 whitespace-nowrap text-sm tabular-nums">
                      {(row?.price ?? item.remote?.price)?.toLocaleString(
                        "ja-JP",
                      ) ?? "—"}
                      {(row?.price ?? item.remote?.price) != null ? "円" : ""}
                    </p>
                  </td>
                  <td className="px-2 py-5 text-center align-top">
                    {canEdit &&
                    row &&
                    !archived &&
                    !sold &&
                    row.quantity > 0 &&
                    !EC_CHANNELS.some((c) =>
                      isProtectedSale(item, catalog, c),
                    ) ? (
                      <button
                        className={button + " whitespace-nowrap !px-2 !text-xs"}
                        disabled={!actionsReady}
                        onClick={() =>
                          setOperation({
                            action: { kind: "COMMON_PUBLISH" },
                            items: [row],
                          })
                        }
                      >
                        まとめて出品
                      </button>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  {EC_CHANNELS.map((c) => {
                    const s = overviewChannel(item, catalog, c),
                      protectedSale = isProtectedSale(item, catalog, c),
                      price = row ? ecOverviewPrice(row, c) : null;
                    const label = protectedSale
                      ? "売却先・保持"
                      : s.source === "ECONVENI" && s.state === "UNLISTED"
                        ? "出品なし"
                        : EC_STATE_LABEL[s.state];
                    return (
                      <td
                        key={c}
                        className="border-l border-slate-100 px-4 py-5 align-top"
                      >
                        <span
                          className={
                            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold " +
                            (protectedSale
                              ? "bg-slate-100 text-slate-600"
                              : badge[s.state])
                          }
                        >
                          <span
                            className={
                              "h-1.5 w-1.5 rounded-full " +
                              (!protectedSale && s.state === "ACTIVE"
                                ? "bg-emerald-600"
                                : "bg-current opacity-50")
                            }
                          />
                          {label}
                        </span>
                        <p className="mb-3 mt-2 text-base font-semibold tabular-nums">
                          {price == null
                            ? "—"
                            : price.toLocaleString("ja-JP") + "円"}
                        </p>
                        {canEdit && row && !archived && !protectedSale && (
                          <div className="flex flex-wrap gap-2">
                            {["ACTIVE", "ERROR"].includes(s.state) ? (
                              <button
                                className={button + " !px-2.5 !py-1.5 !text-xs"}
                                disabled={!actionsReady}
                                onClick={() => open("STOP", [row], c)}
                              >
                                出品を停止
                              </button>
                            ) : (
                              !sold &&
                              row.quantity > 0 &&
                              !["UNKNOWN", "PENDING"].includes(s.state) && (
                                <button
                                  className={
                                    button +
                                    " !border-teal-300 !px-2.5 !py-1.5 !text-xs !text-teal-800"
                                  }
                                  disabled={!actionsReady}
                                  onClick={() => open("PUBLISH", [row], c)}
                                >
                                  出品
                                </button>
                              )
                            )}
                          </div>
                        )}
                        {(s.url ||
                          s.note ||
                          (canEdit &&
                            row &&
                            s.externalId &&
                            !protectedSale)) && (
                          <details className="mt-3 text-xs text-slate-500">
                            <summary className="cursor-pointer hover:text-slate-800">
                              詳細
                            </summary>
                            <div className="mt-2 space-y-2">
                              {s.url && (
                                <a
                                  href={s.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block text-teal-800 underline"
                                >
                                  商品ページを開く ↗
                                </a>
                              )}
                              {s.note && (
                                <p
                                  className={
                                    "leading-5 " +
                                    (s.state === "ERROR"
                                      ? "text-amber-800"
                                      : "")
                                  }
                                >
                                  {s.note}
                                </p>
                              )}
                              {canEdit &&
                                row &&
                                s.externalId &&
                                !protectedSale && (
                                  <button
                                    className={button + " !text-xs"}
                                    disabled={
                                      !actionsReady ||
                                      ["PENDING", "UNKNOWN"].includes(s.state)
                                    }
                                    onClick={() => open("UPDATE", [row], c)}
                                  >
                                    商品内容を更新
                                  </button>
                                )}
                            </div>
                          </details>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!pageItems.length && (
          <p className="p-10 text-center text-sm text-slate-500">
            {catalogBusy
              ? "eコンビニの商品を読み込み中…"
              : source === "ECONVENI" && !catalog?.econveni
                ? "eコンビニ連携から商品一覧を取得してください。"
                : "条件に合う商品はありません。"}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-4 text-sm">
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
      {manualOpen && (
        <EconveniManualDialog
          rows={rows}
          run={econveniManualSyncAction}
          onClose={() => setManualOpen(false)}
          onChanged={() => void loadCatalog()}
          renderPhoto={(row) => (
            <div className="h-full w-full [&_img]:!h-full [&_img]:!w-full [&_div]:max-h-full">
              <InventoryThumbnail
                storageKey={row.thumbnailKey}
                directUrl={resolveListPhotoUrl(
                  !!row.thumbnailIsPrimary,
                  photoThumbnails[row.inventoryId],
                )}
                alt={row.name}
                size="heroContain"
              />
            </div>
          )}
        />
      )}
      {operation && (
        <EcBulkDialog
          items={operation.items}
          action={operation.action}
          onClose={() => setOperation(null)}
          onChanged={(doneIds) => {
            setSelected(
              (s) => new Set([...s].filter((id) => !doneIds.includes(id))),
            );
            void loadCatalog();
            void listListingsOverviewSafeAction().then((r) =>
              setState(loadStateFromInitialRows(r)),
            );
          }}
        />
      )}
    </div>
  );
}
