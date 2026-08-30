"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createCustomFieldAction,
  reorderCustomFieldsAction,
  setCustomFieldActiveAction,
  updateCustomFieldAction,
} from "@/app/actions/customFields";
import type { CustomFieldDefinitionRow } from "@/lib/inventory/queries";

interface CustomFieldSettingsProps {
  fields: CustomFieldDefinitionRow[];
  readOnly: boolean;
}

const TYPE_LABELS: Record<CustomFieldDefinitionRow["fieldType"], string> = {
  TEXT: "文字",
  TEXTAREA: "複数行文字",
  NUMBER: "数値",
  SELECT: "選択式",
  DATE: "日付",
  URL: "URL",
};

const TYPE_OPTIONS = Object.entries(TYPE_LABELS) as [CustomFieldDefinitionRow["fieldType"], string][];

function optionsToText(options: string[]): string {
  return options.join("\n");
}
function textToOptions(text: string): string[] {
  return text
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 追加項目(CustomFieldDefinition)の管理タブ (夜間開発指示書 §11)。
 * MasterList.tsx(カテゴリ/保管場所/単位)と同じ「Server Action呼び出し
 * → router.refresh()」の形を踏襲するが、種類ごとに必要な入力(選択式
 * だけ選択肢欄が要る等)が絡むため独立したコンポーネントにしている。
 *
 * 追加した項目は新規登録・編集・詳細・詳細検索・Import/Exportへコー
 * ド変更なしで反映される(既存のCustomFieldDefinition metadata-driven
 * 実装をそのまま使うため — customFieldSeed.tsの既存コメント、
 * lib/inventory/advancedSearch.ts参照)。「削除」は提供せず「無効化」
 * のみ — 理由はlib/inventory/customFields.tsのsetCustomFieldDefinitionActive
 * コメント参照(既存レコードのcustomFields JSON内の値を宙に浮かせない
 * ため)。
 */
export function CustomFieldSettings({ fields, readOnly }: CustomFieldSettingsProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // 新規作成フォーム
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<CustomFieldDefinitionRow["fieldType"]>("TEXT");
  const [newRequired, setNewRequired] = useState(false);
  const [newOptionsText, setNewOptionsText] = useState("");

  // 編集中の行
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editRequired, setEditRequired] = useState(false);
  const [editOptionsText, setEditOptionsText] = useState("");

  function run(action: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "操作に失敗しました。");
      }
    });
  }

  function handleCreate() {
    const label = newLabel.trim();
    if (!label) return;
    run(async () => {
      await createCustomFieldAction({ label, fieldType: newType, required: newRequired, options: textToOptions(newOptionsText) });
      setNewLabel("");
      setNewType("TEXT");
      setNewRequired(false);
      setNewOptionsText("");
    });
  }

  function startEdit(field: CustomFieldDefinitionRow) {
    setEditingId(field.id);
    setEditLabel(field.label);
    setEditRequired(field.required);
    setEditOptionsText(optionsToText(field.options));
  }

  function commitEdit() {
    const id = editingId;
    const label = editLabel.trim();
    if (!id || !label) {
      setEditingId(null);
      return;
    }
    run(async () => {
      await updateCustomFieldAction(id, { label, required: editRequired, options: textToOptions(editOptionsText) });
      setEditingId(null);
    });
  }

  function toggleActive(field: CustomFieldDefinitionRow) {
    run(() => setCustomFieldActiveAction(field.id, !field.isActive));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[index], next[target]] = [next[target], next[index]];
    run(() => reorderCustomFieldsAction(next.map((f) => f.id)));
  }

  return (
    <div>
      <p className="mb-3 max-w-xl text-[12px] text-gray-500">
        新規登録・編集フォーム、商品詳細、一覧表示設定、詳細検索、CSV/Excelインポート・エクスポートに、コード変更なしでそのまま反映されます。
        種類(文字/数値/日付等)は作成後に変更できません — 型を変えたい場合は新しい項目を作り、古い方は無効化してください。
        「削除」は提供していません(既存の在庫データを壊さないため) — 使わなくなった項目は無効化してください。
      </p>

      {readOnly && (
        <p className="mb-3 border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-500">
          閲覧のみです。追加項目の作成・変更にはADMIN権限が必要です。
        </p>
      )}

      {!readOnly && (
        <div className="mb-4 max-w-xl border border-gray-200 p-3">
          <p className="mb-2 text-[11px] font-bold text-gray-500">新しい追加項目を作成</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-gray-500">項目名</label>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="例: 木材の種類"
                className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] text-gray-500">種類</label>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as CustomFieldDefinitionRow["fieldType"])}
                className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
              >
                {TYPE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {newType === "SELECT" && (
            <div className="mt-2">
              <label className="block text-[11px] text-gray-500">選択肢（1行に1つ、またはカンマ区切り）</label>
              <textarea
                value={newOptionsText}
                onChange={(e) => setNewOptionsText(e.target.value)}
                rows={3}
                className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
              />
            </div>
          )}
          <label className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-gray-600">
            <input type="checkbox" checked={newRequired} onChange={(e) => setNewRequired(e.target.checked)} />
            必須項目にする
          </label>
          <div className="mt-2">
            <button
              type="button"
              onClick={handleCreate}
              disabled={pending || !newLabel.trim() || (newType === "SELECT" && textToOptions(newOptionsText).length === 0)}
              className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              作成
            </button>
          </div>
        </div>
      )}

      {error && <p className="mb-3 text-[12px] text-red-600">{error}</p>}

      <table className="w-full max-w-2xl border-collapse text-[13px]">
        <thead className="text-left text-[11px] text-gray-400">
          <tr className="border-b border-gray-200">
            <th className="w-14 py-1.5 font-normal">並び順</th>
            <th className="py-1.5 font-normal">項目名</th>
            <th className="w-20 py-1.5 font-normal">種類</th>
            <th className="w-14 py-1.5 font-normal">必須</th>
            <th className="w-16 py-1.5 font-normal">状態</th>
            {!readOnly && <th className="w-16 py-1.5 font-normal">操作</th>}
          </tr>
        </thead>
        <tbody>
          {fields.length === 0 && (
            <tr>
              <td colSpan={readOnly ? 5 : 6} className="py-4 text-center text-gray-400">
                追加項目がまだありません。
              </td>
            </tr>
          )}
          {fields.map((field, index) => (
            <tr key={field.id} className={`border-b border-gray-100 align-top ${field.isActive ? "" : "text-gray-400"}`}>
              <td className="py-1.5">
                {/* 並び替えの ↑/↓ はグリフだけを置くと実測13x20pxしか
                    無く、モバイル(375-430px)では隣のボタンと押し分けられ
                    ない。文字サイズは変えずに、当たり判定だけを32px角へ
                    広げる(min-h-8/min-w-8 + inline-flexで中央寄せ)。 */}
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={readOnly || pending || index === 0}
                    aria-label="1つ上へ移動"
                    className="inline-flex min-h-8 min-w-8 items-center justify-center disabled:text-gray-200"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={readOnly || pending || index === fields.length - 1}
                    aria-label="1つ下へ移動"
                    className="inline-flex min-h-8 min-w-8 items-center justify-center disabled:text-gray-200"
                  >
                    ↓
                  </button>
                </div>
              </td>
              <td className="py-1.5 pr-3">
                {editingId === field.id ? (
                  <div className="space-y-1">
                    <input
                      autoFocus
                      type="text"
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                      className="w-48 border border-gray-400 px-1.5 py-0.5 text-[13px] focus:outline-none"
                    />
                    {field.fieldType === "SELECT" && (
                      <textarea
                        value={editOptionsText}
                        onChange={(e) => setEditOptionsText(e.target.value)}
                        rows={2}
                        placeholder="選択肢（1行に1つ）"
                        className="block w-56 border border-gray-300 px-1.5 py-0.5 text-[12px] focus:outline-none"
                      />
                    )}
                    <label className="flex items-center gap-1 text-[11px] text-gray-500">
                      <input type="checkbox" checked={editRequired} onChange={(e) => setEditRequired(e.target.checked)} />
                      必須
                    </label>
                    <div className="flex gap-2">
                      <button type="button" onClick={commitEdit} className="text-[11px] text-gray-700 hover:underline">
                        保存
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className="text-[11px] text-gray-400 hover:underline">
                        キャンセル
                      </button>
                    </div>
                  </div>
                ) : (
                  <span className={!readOnly ? "cursor-pointer hover:underline" : ""} onClick={() => !readOnly && startEdit(field)}>
                    {field.label}
                  </span>
                )}
                {field.fieldType === "SELECT" && editingId !== field.id && (
                  <p className="mt-0.5 text-[10px] text-gray-400">選択肢: {field.options.join(" / ") || "（未設定）"}</p>
                )}
              </td>
              <td className="py-1.5 text-gray-500">{TYPE_LABELS[field.fieldType]}</td>
              <td className="py-1.5 text-gray-500">{field.required ? "必須" : "-"}</td>
              <td className="py-1.5">
                <button
                  type="button"
                  onClick={() => toggleActive(field)}
                  disabled={readOnly || pending}
                  title={readOnly ? undefined : field.isActive ? "クリックで無効化" : "クリックで有効化"}
                  className={`inline-flex min-h-8 items-center justify-center gap-1 border px-2 py-0.5 text-[11px] ${
                    field.isActive ? "border-gray-300 text-gray-600" : "border-gray-200 text-gray-400"
                  } ${readOnly ? "" : "hover:bg-gray-50"}`}
                >
                  <span>{field.isActive ? "有効" : "無効"}</span>
                  <span aria-hidden="true">{field.isActive ? "●" : "○"}</span>
                </button>
              </td>
              {!readOnly && <td className="py-1.5" />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
