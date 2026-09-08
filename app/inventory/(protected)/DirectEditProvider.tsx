"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { bulkUpdateInventoryListFields, type BulkInventoryEditItemResult } from "@/app/actions/inventoryBulkEdit";
import type { InlineEditChanges, InlineEditFieldKey } from "@/lib/inventory/inlineEdit";
import type { InventoryListRow } from "@/lib/inventory/queries";
import { useUnsavedChanges } from "../UnsavedChangesProvider";

/**
 * 一覧直接編集 (統合改善指示書 §11-13) の状態を、ヘッダー内の「直接編
 * 集」ボタン(InventoryToolbar)とテーブル本体(InventoryTable)の間で共
 * 有するための、このページ専用のContext。両者はpage.tsxの中で別々の
 * 位置に描画される(ヘッダーはInventoryHeaderのcenterスロット、テーブ
 * ルは本文側)ため、propsのバケツリレーではなくContextで共有する。
 *
 * dirty状態は既存のUnsavedChangesProvider(ロゴ/ナビゲーション用の汎用
 * ガード)へもそのまま連携する — 新しい別のガードを増やさず、既存の
 * 3択ダイアログ・beforeunloadをそのまま再利用する(spec §13/§14/§22)。
 */

type FieldValue = InlineEditChanges[keyof InlineEditChanges];

interface DirectEditContextValue {
  enabled: boolean;
  toggleEnabled: () => void;
  /** Per-row pending overrides, keyed by Inventory id. A row not present here has no unsaved edits. */
  edits: Record<string, InlineEditChanges>;
  getValue: <K extends keyof InlineEditChanges>(row: InventoryListRow, field: K) => InlineEditChanges[K] | undefined;
  setValue: (rowId: string, field: InlineEditFieldKey, value: FieldValue) => void;
  isRowDirty: (rowId: string) => boolean;
  dirtyCount: number;
  saving: boolean;
  lastResult: { successCount: number; failCount: number; errors: { id: string; name: string; error: string }[] } | null;
  /**
   * QA-004: bulkUpdateInventoryListFields自体の呼び出しが例外で落ちた場合
   * (読み取り専用proxyのPOST拒否など、個々の商品の処理まで届かない通信
   * 失敗)のメッセージ。lastResultは「何件中何件失敗したか」という
   * per-item結果の器であり、そこへ届く前の失敗はここで別に持つ — 両者
   * を混ぜると「0件処理された」のか「何も送れなかった」のか区別できなく
   * なる。
   */
  saveError: string | null;
  saveDirty: () => Promise<void>;
  saveAndExit: () => Promise<void>;
  discardAndExit: () => void;
}

const DirectEditContext = createContext<DirectEditContextValue | null>(null);

/** Maps a list column key to the actual Inventory field name InlineEditChanges/the bulk Server Action use — the one place this correspondence is declared (InventoryTable and this provider both use it). */
const COLUMN_TO_FIELD: Record<InlineEditFieldKey, keyof InlineEditChanges> = {
  name: "name",
  quantity: "quantity",
  location: "locationId",
  category: "categoryId",
  plannedSalePrice: "plannedSalePrice",
  salePrice: "salePrice",
  purchasePrice: "purchasePrice",
  market: "market",
  note: "note",
  conditionRating: "conditionRating",
  damageNotes: "damageNotes",
};

export function DirectEditProvider({ rows, children }: { rows: InventoryListRow[]; children: React.ReactNode }) {
  const { setDirty, registerSaveHandler, registerDiscardHandler } = useUnsavedChanges();
  const [enabled, setEnabled] = useState(false);
  const [edits, setEdits] = useState<Record<string, InlineEditChanges>>({});
  const [saving, setSaving] = useState(false);
  const [lastResult, setLastResult] = useState<DirectEditContextValue["lastResult"]>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  /** A field only counts as "changed" once it actually differs from the row's current saved value — typing into a cell and typing back to the original value un-dirties it (spec §12: 元の値へ戻した場合はdirty再判定). */
  function isFieldChanged(row: InventoryListRow, field: keyof InlineEditChanges, value: FieldValue): boolean {
    switch (field) {
      case "name":
        return value !== row.name;
      case "quantity":
        return value !== row.quantity;
      case "locationId":
        return (value ?? null) !== row.locationId;
      case "categoryId":
        return (value ?? null) !== row.categoryId;
      case "plannedSalePrice":
        return (value ?? null) !== row.plannedSalePrice;
      case "salePrice":
        return (value ?? null) !== row.salePrice;
      case "purchasePrice":
        return (value ?? null) !== row.purchasePrice;
      case "market":
        return (value ?? null) !== row.market;
      case "note":
        return (value ?? null) !== row.note;
      case "conditionRating":
        return (value ?? null) !== row.conditionRating;
      case "damageNotes":
        return (value ?? null) !== row.damageNotes;
      default:
        return true;
    }
  }

  const setValue = useCallback(
    (rowId: string, column: InlineEditFieldKey, value: FieldValue) => {
      const row = rowsById.get(rowId);
      if (!row) return;
      const field = COLUMN_TO_FIELD[column];
      setEdits((prev) => {
        const rowEdits = { ...(prev[rowId] ?? {}) };
        if (isFieldChanged(row, field, value)) {
          (rowEdits as Record<string, FieldValue>)[field] = value;
        } else {
          delete (rowEdits as Record<string, FieldValue>)[field];
        }
        const next = { ...prev };
        if (Object.keys(rowEdits).length === 0) {
          delete next[rowId];
        } else {
          next[rowId] = rowEdits;
        }
        return next;
      });
    },
    [rowsById],
  );

  const getValue = useCallback(
    <K extends keyof InlineEditChanges>(row: InventoryListRow, columnField: K): InlineEditChanges[K] | undefined =>
      edits[row.id]?.[columnField],
    [edits],
  );

  const isRowDirty = useCallback((rowId: string) => Boolean(edits[rowId] && Object.keys(edits[rowId]).length > 0), [edits]);

  const dirtyCount = Object.keys(edits).length;

  async function performSave(): Promise<{ success: boolean }> {
    const items = Object.entries(edits).map(([id, changes]) => ({ id, changes }));
    if (items.length === 0) return { success: true };

    setSaving(true);
    setSaveError(null);
    try {
      const results: BulkInventoryEditItemResult[] = await bulkUpdateInventoryListFields(items);
      const failed = results.filter((r) => !r.success);
      const succeededIds = new Set(results.filter((r) => r.success).map((r) => r.id));

      // 成功した行だけdirty解除、失敗した行はdirtyのまま残す(spec §12)。
      setEdits((prev) => {
        const next = { ...prev };
        for (const id of succeededIds) delete next[id];
        return next;
      });

      setLastResult({
        successCount: succeededIds.size,
        failCount: failed.length,
        errors: failed.map((f) => ({ id: f.id, name: rowsById.get(f.id)?.name ?? f.id, error: f.error ?? "更新に失敗しました。" })),
      });

      return { success: failed.length === 0 };
    } catch (err) {
      // QA-004 P2: bulkUpdateInventoryListFields自体の呼び出しが例外で
      // 落ちた場合(読み取り専用proxyのPOST拒否(405)など、個々の商品の
      // 処理まで届いていない通信失敗)。ここでerr.messageをそのまま画面
      // に出すと、"Cannot read properties of undefined (reading
      // 'filter')" のような技術的な文言(実際に発生: 405で戻り値がresults
      // ではなくなり、直後のresults.filter(...)がそのTypeErrorを投げて
      // ここで拾われていた)がスタッフに理解不能な形で見えてしまう。また
      // 通信が途切れたタイミング次第ではサーバー側の処理は実は届いていた
      // 可能性もあるため、「一切保存されていない」と断定する文言にもし
      // ない — 保存結果を確認できなかった旨と、入力保持・再試行の案内に
      // 統一する。詳細は開発者向けにconsoleへ残す。editsは一切変更しな
      // い — 何も確認できていないので全行dirtyのまま保持し、再試行可能
      // にする。
      console.error("[DirectEdit] performSave failed", err);
      setLastResult(null);
      setSaveError("保存結果を確認できませんでした。通信状態を確認して、もう一度お試しください。入力内容は保持されています。");
      return { success: false };
    } finally {
      setSaving(false);
    }
  }

  async function saveDirty() {
    await performSave();
  }

  async function saveAndExit() {
    const result = await performSave();
    if (result.success) setEnabled(false);
  }

  function discardAndExit() {
    setEdits({});
    setLastResult(null);
    setSaveError(null);
    setEnabled(false);
  }

  /**
   * dirty行がある間は呼ばれない想定 — その間はInventoryToolbar側が
   * このトグルボタンの代わりに「保存する/保存して終了/破棄して終了」
   * の3つの明示的なボタンを表示するため(spec §11の独自の操作群。
   * ロゴ/フィルタ/ページング等、直接編集モード自体とは無関係な画面遷移
   * を試みた場合の確認は、別途UnsavedChangesProviderの汎用3択ダイア
   * ログが担当する — spec §14)。
   */
  function toggleEnabled() {
    setEnabled((v) => !v);
    setLastResult(null);
    setSaveError(null);
  }

  useEffect(() => {
    setDirty(dirtyCount > 0);
  }, [dirtyCount, setDirty]);

  useEffect(() => {
    registerSaveHandler(async () => performSave());
    registerDiscardHandler(() => {
      setEdits({});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const value: DirectEditContextValue = {
    enabled,
    toggleEnabled,
    edits,
    getValue,
    setValue,
    isRowDirty,
    dirtyCount,
    saving,
    lastResult,
    saveError,
    saveDirty,
    saveAndExit,
    discardAndExit,
  };

  return <DirectEditContext.Provider value={value}>{children}</DirectEditContext.Provider>;
}

export function useDirectEdit(): DirectEditContextValue {
  const ctx = useContext(DirectEditContext);
  if (!ctx) throw new Error("useDirectEdit must be used within DirectEditProvider");
  return ctx;
}
