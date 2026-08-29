"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { CustomFieldDefinitionRow, InventoryListRow, MasterOption, StatusOption } from "@/lib/inventory/queries";
import { INVENTORY_LIST_COLUMNS, MIN_COLUMN_WIDTH, dynamicColumnDefsFrom, type InventoryListColumnDef } from "@/lib/inventory/listColumns";
import { isInlineEditableColumn, type InlineEditFieldKey } from "@/lib/inventory/inlineEdit";
import { useInventoryListColumns } from "../useInventoryListColumns";
import { InventoryThumbnail } from "../InventoryThumbnail";
import { useDirectEdit } from "./DirectEditProvider";

interface InventoryTableProps {
  rows: InventoryListRow[];
  categories: MasterOption[];
  locations: MasterOption[];
  categoriesById: Record<string, MasterOption>;
  locationsById: Record<string, MasterOption>;
  statusesById: Record<string, StatusOption>;
  /** 追加項目(CustomFieldDefinition)を動的な一覧列として表示するため(夜間開発指示書 §11)。 */
  customFieldDefs: CustomFieldDefinitionRow[];
}

/** `cf:<fieldKey>`列(動的なCustomField列)の値をrow.customFieldsから読む — 静的列と混在した同じレンダリングループから、どちらの種類の列かをkeyの接頭辞だけで判定できる。 */
function customFieldValueFromRow(row: InventoryListRow, columnKey: string): string {
  const fieldKey = columnKey.slice(3);
  const v = row.customFields?.[fieldKey];
  return v === null || v === undefined ? "" : String(v);
}

function formatYen(value: number | null): string {
  if (value === null) return "-";
  return value.toLocaleString("ja-JP");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP");
}

function formatAwsDate(value: string | null): string {
  return value ? value.replace(/-/g, "/") : "-";
}

const numCell = "px-2 py-1 text-right tabular-nums overflow-hidden";
const cell = "px-2 py-1 overflow-hidden";
/** 一覧直接編集で入力中のセルは<td>のpaddingを持たない — inputClass自身のpx-2 py-1がinsetを肩代わりする(二重padding防止、通常表示との密度統一)。 */
const editableCell = "overflow-hidden";

/** 右寄せ表示する列(数値系)。幅そのものはlib/inventory/listColumns.tsのdefaultWidth + ユーザーのドラッグ操作(useInventoryListColumns.widths)へ一本化した — 列幅の初期値・保存値を二重管理しない。 */
const RIGHT_ALIGN_COLUMNS = new Set(["quantity", "purchasePrice", "plannedSalePrice", "salePrice", "saleCommission"]);

/** チェックボックス列は固定幅でよい(spec §13)。 */
const CHECKBOX_COLUMN_WIDTH = 32;

function renderReadOnlyCell(
  key: string,
  row: InventoryListRow,
  categoriesById: Record<string, MasterOption>,
  locationsById: Record<string, MasterOption>,
  statusesById: Record<string, StatusOption>,
): React.ReactNode {
  if (key.startsWith("cf:")) {
    const value = customFieldValueFromRow(row, key);
    return (
      <span className="block truncate text-gray-600" title={value || undefined}>
        {value || "-"}
      </span>
    );
  }
  switch (key) {
    case "image":
      // "list" (3:2, object-contain) — see InventoryThumbnail's own
      // comment. row.mainImageStorageKey is already the resolved top
      // image (see lib/inventory/queries.ts's toListRow), never just
      // "whichever image happens to sort first".
      return <InventoryThumbnail storageKey={row.mainImageStorageKey} alt={row.name} size="list" />;
    case "status": {
      const status = row.statusId ? statusesById[row.statusId] : undefined;
      return status ? (
        <span className="inline-block border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700">{status.label}</span>
      ) : (
        <span className="text-gray-300">-</span>
      );
    }
    case "sku":
      return <span className="block truncate font-mono text-[12px] text-gray-700">{row.displayId}</span>;
    case "name":
      return (
        <span className="block truncate font-medium text-gray-900" title={row.name}>
          {row.name}
        </span>
      );
    case "quantity":
      return row.quantity;
    case "location": {
      const location = row.locationId ? locationsById[row.locationId] : undefined;
      return (
        <span className="block truncate text-gray-600" title={location?.name}>
          {location?.name ?? "-"}
        </span>
      );
    }
    case "category": {
      const category = row.categoryId ? categoriesById[row.categoryId] : undefined;
      return (
        <span className="block truncate text-gray-600" title={category?.name}>
          {category?.name ?? "-"}
        </span>
      );
    }
    case "purchasePrice":
      return formatYen(row.purchasePrice);
    case "plannedSalePrice":
      return formatYen(row.plannedSalePrice);
    case "salePrice":
      return formatYen(row.salePrice);
    case "note":
      return (
        <span className="block truncate text-gray-500" title={row.note ?? undefined}>
          {row.note ?? ""}
        </span>
      );
    case "updatedAt":
      return formatDate(row.updatedAt);
    case "barcode":
      return <span className="block truncate font-mono text-[12px] text-gray-600">{row.barcode ?? "-"}</span>;
    case "saleCommission":
      return formatYen(row.saleCommission);
    case "market":
      return row.market ?? "-";
    case "saleStartDate":
      return formatAwsDate(row.saleStartDate);
    case "saleEndDate":
      return formatAwsDate(row.saleEndDate);
    case "width":
      return row.width ?? "-";
    case "depth":
      return row.depth ?? "-";
    case "height":
      return row.height ?? "-";
    case "conditionRating":
      return (
        <span className="block truncate text-gray-600" title={row.conditionRating ?? undefined}>
          {row.conditionRating ?? "-"}
        </span>
      );
    case "damageNotes":
      return (
        <span className="block truncate text-gray-600" title={row.damageNotes ?? undefined}>
          {row.damageNotes ?? "-"}
        </span>
      );
    case "transactionDate":
      return formatAwsDate(row.transactionDate);
    case "transactionType":
      return row.transactionType ?? "-";
    case "adminMemo":
      return (
        <span className="block truncate text-gray-600" title={row.adminMemo ?? undefined}>
          {row.adminMemo ?? "-"}
        </span>
      );
    default:
      return null;
  }
}

/**
 * The editable-cell counterpart to renderReadOnlyCell, used only while
 * 一覧直接編集 is active (統合改善指示書 §11) — only for the whitelisted
 * columns lib/inventory/inlineEdit.ts declares safe for quick inline
 * edits. Every input is *uncontrolled-looking* but backed by
 * DirectEditProvider's edits map: `value` always falls back to the row's
 * current saved value when there's no pending edit, so an untouched cell
 * shows exactly what renderReadOnlyCell would.
 */
function renderEditableCell(
  column: InlineEditFieldKey,
  row: InventoryListRow,
  categories: MasterOption[],
  locations: MasterOption[],
  getValue: ReturnType<typeof useDirectEdit>["getValue"],
  setValue: ReturnType<typeof useDirectEdit>["setValue"],
): React.ReactNode {
  // 通常表示の読み取り専用セル(<td>のpx-2 py-1だけがinsetで、中身の
  // <span>自体は余白を持たない)と見た目の密度を揃える(夜間開発の
  // フォローアップ: 「通常一覧とDirect Editでヘッダー幅感が違う」) —
  // 編集モードの<td>はpaddingを0にし(下のnumCell/cellの分岐参照)、
  // その分をinput自身のpx-2 py-1が肩代わりする。<td>のpaddingとinputの
  // paddingが二重にならないため、同じ列幅で読み取り時と編集時の実効的
  // な余白が一致する。
  const inputClass = "block w-full border border-gray-300 bg-white px-2 py-1 text-[12px] focus:border-gray-500 focus:outline-none";

  switch (column) {
    case "name": {
      const value = getValue(row, "name") ?? row.name;
      return <input type="text" value={value} onChange={(e) => setValue(row.id, column, e.target.value)} className={inputClass} />;
    }
    case "quantity": {
      const value = getValue(row, "quantity") ?? row.quantity;
      return (
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => setValue(row.id, column, e.target.value === "" ? null : Number(e.target.value))}
          className={`${inputClass} text-right`}
        />
      );
    }
    case "location": {
      const value = getValue(row, "locationId") ?? row.locationId ?? "";
      return (
        <select value={value ?? ""} onChange={(e) => setValue(row.id, column, e.target.value || null)} className={inputClass}>
          <option value="">未選択</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      );
    }
    case "category": {
      const value = getValue(row, "categoryId") ?? row.categoryId ?? "";
      return (
        <select value={value ?? ""} onChange={(e) => setValue(row.id, column, e.target.value || null)} className={inputClass}>
          <option value="">未選択</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      );
    }
    case "plannedSalePrice":
    case "salePrice":
    case "purchasePrice": {
      const current = column === "plannedSalePrice" ? row.plannedSalePrice : column === "salePrice" ? row.salePrice : row.purchasePrice;
      const value = getValue(row, column) ?? current;
      return (
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => setValue(row.id, column, e.target.value === "" ? null : Number(e.target.value))}
          className={`${inputClass} text-right`}
        />
      );
    }
    case "market": {
      const value = getValue(row, "market") ?? row.market ?? "";
      return <input type="text" value={value ?? ""} onChange={(e) => setValue(row.id, column, e.target.value || null)} className={inputClass} />;
    }
    case "note":
    case "conditionRating":
    case "damageNotes": {
      const current = column === "note" ? row.note : column === "conditionRating" ? row.conditionRating : row.damageNotes;
      const value = getValue(row, column) ?? current;
      return (
        <textarea
          value={value ?? ""}
          onChange={(e) => setValue(row.id, column, e.target.value || null)}
          rows={1}
          className={`${inputClass} resize-y`}
        />
      );
    }
    default:
      // Every InlineEditFieldKey is handled above — this branch exists
      // only so TS sees a return on every path.
      return null;
  }
}

/**
 * High-density table — deliberately not a card grid. Every data cell's
 * content is its own block-level Link into the detail page, so the whole
 * row reads as clickable without extra onClick wiring — EXCEPT while
 * 一覧直接編集 (統合改善指示書 §11) is active, when navigation is
 * disabled entirely and inline-editable cells become real inputs
 * instead (spec §21: 商品詳細への遷移と一覧直接編集は混ぜない).
 *
 * Which columns render, and in what order, is driven by
 * useInventoryListColumns (a per-browser localStorage preference set
 * from /inventory/settings) — the exact same component/props/sizing
 * either way, so the plain list and a 詳細検索-filtered result set can
 * never visually diverge: this is the only place either one renders a
 * row.
 */
export function InventoryTable({ rows, categories, locations, categoriesById, locationsById, statusesById, customFieldDefs }: InventoryTableProps) {
  // 追加項目(CustomFieldDefinition)を動的な一覧列として扱う(夜間開発
  // 指示書 §11) — customFieldDefsが変わらない限りuseMemoで同じ配列参照
  // を保つ(useInventoryListColumns内のuseEffectの依存に使われるため)。
  const dynamicColumns: InventoryListColumnDef[] = useMemo(() => dynamicColumnDefsFrom(customFieldDefs), [customFieldDefs]);
  const { visibility, order, widths, setColumnWidth } = useInventoryListColumns(dynamicColumns);
  const columnByKey = new Map([...INVENTORY_LIST_COLUMNS, ...dynamicColumns].map((c) => [c.key, c]));
  const visibleColumns = order.map((key) => columnByKey.get(key)).filter((c): c is NonNullable<typeof c> => Boolean(c) && visibility[c!.key]);

  const { enabled: directEditEnabled, getValue, setValue, isRowDirty } = useDirectEdit();

  // ── 列幅ドラッグリサイズ(夜間開発指示書 §13、フォローアップでPointer
  // Eventsへ全面書き換え) ────────────────────────────────────────────
  // window.addEventListener("mousemove"/...)ではなく、ハンドル要素自身
  // へのPointer Capture(setPointerCapture)方式にした — こちらは
  // useEffectの依存配列(旧実装ではsetColumnWidthの参照が変わるたびに
  // 登録し直していた)やイベント登録タイミングに一切依存せず、
  // pointerdownを受けた要素がpointerId分のその後のmove/upを確実に
  // (ポインタが要素の外へ出ても)受け取り続けるブラウザ標準の仕組みの
  // ため、より壊れにくい。
  //
  // draggingRef: ドラッグ中だけ意味を持つ値(どの列を・どこから・元の
  // 幅は何pxだったか、どのpointerIdか) — pointermoveのたびにReact
  // stateへ積むと不要な再レンダリングの依存関係が増えるため、refに逃
  // がして実際に再レンダリングが必要な「今の見た目の幅」だけを
  // liveWidth stateで持つ。pointerupで初めてuseInventoryListColumns
  // (localStorage)へ確定保存する。
  const draggingRef = useRef<{ key: string; startX: number; startWidth: number; pointerId: number } | null>(null);
  const [liveWidth, setLiveWidth] = useState<{ key: string; width: number } | null>(null);

  const widthFor = useCallback(
    (key: string): number => {
      if (liveWidth && liveWidth.key === key) return liveWidth.width;
      return widths[key] ?? columnByKey.get(key)?.defaultWidth ?? 100;
    },
    // columnByKey is rebuilt every render from a stable static registry — safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveWidth, widths],
  );

  function handleResizePointerDown(e: React.PointerEvent<HTMLDivElement>, key: string) {
    // 商品詳細リンク等への誤クリック防止 — ヘッダーの<th>自体はLinkでは
    // ないが、将来ヘッダークリックでソートする等の機能が乗っても親へは
    // 伝播させない。
    e.preventDefault();
    e.stopPropagation();
    const startWidth = widths[key] ?? columnByKey.get(key)?.defaultWidth ?? 100;
    draggingRef.current = { key, startX: e.clientX, startWidth, pointerId: e.pointerId };
    setLiveWidth({ key, width: startWidth });
    // これ以降のpointermove/pointerupは、ポインタが実際にどこへ移動し
    // てもこのハンドル要素自身へ配送される(標準のPointer Capture) —
    // window/documentへの手動addEventListenerが不要になる。
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function handleResizePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = draggingRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const next = Math.max(MIN_COLUMN_WIDTH, d.startWidth + (e.clientX - d.startX));
    setLiveWidth({ key: d.key, width: next });
  }

  function endResize(e: React.PointerEvent<HTMLDivElement>) {
    const d = draggingRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    setLiveWidth((prev) => {
      if (prev && prev.key === d.key) setColumnWidth(prev.key, prev.width);
      return null;
    });
    draggingRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  if (rows.length === 0) {
    return <p className="p-6 text-sm text-gray-400">該当する在庫がありません。</p>;
  }

  const totalWidth = CHECKBOX_COLUMN_WIDTH + visibleColumns.reduce((sum, col) => sum + widthFor(col.key), 0);

  return (
    <div className="h-full overflow-auto">
      {/* table-layout: fixed + 明示的なtable幅(全可視列の合計) — これが
          ないとブラウザは内容量に応じて列幅を自動調整し直してしまい、
          ドラッグで設定した幅が反映されない。合計がビューポートを超え
          た分は、外側のoverflow-autoコンテナが横スクロールで吸収する
          (spec §13: 必要幅がviewportを超えたら横スクロール)。 */}
      <table className="border-collapse text-[13px]" style={{ tableLayout: "fixed", width: totalWidth }}>
        <thead className="sticky top-0 z-10 bg-gray-50 text-[11px] text-gray-500">
          <tr className="border-b border-gray-200">
            <th style={{ width: CHECKBOX_COLUMN_WIDTH }} className="px-2 py-1.5"></th>
            {visibleColumns.map((col) => {
              const w = widthFor(col.key);
              const align = RIGHT_ALIGN_COLUMNS.has(col.key) ? "text-right" : "text-left";
              return (
                <th key={col.key} style={{ width: w, minWidth: MIN_COLUMN_WIDTH }} className={`relative select-none px-2 py-1.5 ${align}`}>
                  <span className="block truncate" title={col.label}>
                    {col.label}
                  </span>
                  {/* リサイズハンドル — spec §13/フォローアップ:
                      ヘッダー境界、視覚線より広め(10px)の透明hit area、
                      hover時cursor: col-resize、Pointer Eventsで
                      pointerdown→pointermove→リアルタイム幅変更→pointerup。
                      onClickは意図的に付けない(商品詳細リンク等が無い
                      ヘッダー行なので誤クリックの実害は無いが、念のため
                      pointerdown側でstopPropagationしている)。 */}
                  <div
                    onPointerDown={(e) => handleResizePointerDown(e, col.key)}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`${col.label}列の幅を変更`}
                    className="absolute right-[-5px] top-0 z-10 h-full w-[10px] cursor-col-resize touch-none select-none hover:bg-gray-300 active:bg-gray-400"
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = `/inventory/${row.id}`;
            const dirty = directEditEnabled && isRowDirty(row.id);
            return (
              <tr key={row.id} className={`border-b border-gray-100 ${dirty ? "bg-amber-50" : directEditEnabled ? "" : "hover:bg-gray-50"}`}>
                <td style={{ width: CHECKBOX_COLUMN_WIDTH }} className="px-2 py-1 text-center">
                  <input type="checkbox" className="align-middle" aria-label={`${row.name} を選択`} />
                </td>
                {visibleColumns.map((col) => {
                  const editable = directEditEnabled && isInlineEditableColumn(col.key);
                  const w = widthFor(col.key);
                  return (
                    <td
                      key={col.key}
                      style={{ width: w, minWidth: MIN_COLUMN_WIDTH }}
                      className={editable ? editableCell : RIGHT_ALIGN_COLUMNS.has(col.key) ? numCell : cell}
                    >
                      {editable ? (
                        // `editable` already confirmed col.key passes
                        // isInlineEditableColumn above — TS just can't
                        // track a type guard through an intermediate
                        // boolean variable, hence the assertion.
                        renderEditableCell(col.key as InlineEditFieldKey, row, categories, locations, getValue, setValue)
                      ) : directEditEnabled ? (
                        renderReadOnlyCell(col.key, row, categoriesById, locationsById, statusesById)
                      ) : (
                        <Link href={href} className="block">
                          {renderReadOnlyCell(col.key, row, categoriesById, locationsById, statusesById)}
                        </Link>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
