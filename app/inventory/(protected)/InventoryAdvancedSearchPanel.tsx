"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  operatorNeedsNoValue,
  operatorNeedsSecondValue,
  operatorsForType,
  type AdvancedSearchCondition,
  type AdvancedSearchQuery,
  type SearchFieldDef,
} from "@/lib/inventory/advancedSearch";
import { useUnsavedChanges } from "../UnsavedChangesProvider";
import { DateField } from "../DateField";

interface InventoryAdvancedSearchPanelProps {
  fieldDefs: SearchFieldDef[];
  /** 直前に適用されていた条件(ある場合) — パネルを開き直しても入力内容が消えない。 */
  initialQuery: AdvancedSearchQuery | null;
}

let nextConditionId = 1;
function newConditionId(): string {
  nextConditionId += 1;
  return `c${Date.now()}_${nextConditionId}`;
}

function firstOperatorFor(field: SearchFieldDef): AdvancedSearchCondition["operator"] {
  return operatorsForType(field.valueType)[0].value;
}

function emptyCondition(field: SearchFieldDef): AdvancedSearchCondition {
  return { id: newConditionId(), field: field.key, operator: firstOperatorFor(field) };
}

/**
 * ZAICO同等の汎用詳細検索(夜間開発指示書 §7)。検索対象 → 演算子 → 値
 * の行を「＋条件を追加」で好きなだけ積み、AND/ORを切り替えられる。
 * フィールドの一覧はlib/inventory/advancedSearch.tsのbuildSearchFieldDefs
 * が静的フィールド+CustomFieldDefinitionから毎回動的に生成したものを
 * そのまま受け取るだけ — CustomFieldを追加してもこのファイルを直す必
 * 要はない。
 *
 * 送信すると`/inventory?adv=<JSON>&advanced=1`へ遷移する。既存のクイッ
 * ク検索(`q`)・サイドバー(`categoryIds`/`locationId`)とは独立した経路
 * — 詳細検索が有効な間はそちらを無視する(page.tsxのsearchMode参照)。
 *
 * A Client Component (既存同様) — 条件行の追加/削除/入力はすべてこの
 * コンポーネント内のローカルstateで完結させ、実際にDBへ問い合わせるの
 * は「検索」ボタンで送信した時だけ(タイプ中に毎回サーバーへ飛ばない)。
 */
export function InventoryAdvancedSearchPanel({ fieldDefs, initialQuery }: InventoryAdvancedSearchPanelProps) {
  const router = useRouter();
  const { isDirty, guardedNavigate } = useUnsavedChanges();
  const fieldsByGroup = useMemo(() => {
    const groups = new Map<string, SearchFieldDef[]>();
    for (const f of fieldDefs) {
      const list = groups.get(f.group) ?? [];
      list.push(f);
      groups.set(f.group, list);
    }
    return groups;
  }, [fieldDefs]);
  const fieldsByKey = useMemo(() => new Map(fieldDefs.map((f) => [f.key, f])), [fieldDefs]);
  const firstField = fieldDefs[0];

  const [combinator, setCombinator] = useState<"AND" | "OR">(initialQuery?.combinator ?? "AND");
  const [conditions, setConditions] = useState<AdvancedSearchCondition[]>(
    initialQuery && initialQuery.conditions.length > 0 ? initialQuery.conditions : firstField ? [emptyCondition(firstField)] : [],
  );

  function addCondition() {
    if (!firstField) return;
    setConditions((prev) => [...prev, emptyCondition(firstField)]);
  }

  function removeCondition(id: string) {
    setConditions((prev) => prev.filter((c) => c.id !== id));
  }

  function updateCondition(id: string, patch: Partial<AdvancedSearchCondition>) {
    setConditions((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function handleFieldChange(id: string, fieldKey: string) {
    const field = fieldsByKey.get(fieldKey);
    if (!field) return;
    updateCondition(id, { field: fieldKey, operator: firstOperatorFor(field), value: undefined, value2: undefined });
  }

  function reset() {
    setCombinator("AND");
    setConditions(firstField ? [emptyCondition(firstField)] : []);
    const href = "/inventory";
    if (isDirty) guardedNavigate(href);
    else router.push(href);
  }

  function submit() {
    const query: AdvancedSearchQuery = { combinator, conditions };
    const sp = new URLSearchParams();
    sp.set("adv", JSON.stringify(query));
    sp.set("advanced", "1");
    const href = `/inventory?${sp.toString()}`;
    if (isDirty) guardedNavigate(href);
    else router.push(href);
  }

  function closePanel() {
    const sp = new URLSearchParams();
    // 「閉じる」だけでは検索条件を消さない — adv/advancedをそのまま
    // 保持しつつパネルだけ閉じる(spec: 「閉じる」だけでは検索条件を
    // 消さないこと)。実際に条件を消すのは「リセット」ボタン。
    if (initialQuery) sp.set("adv", JSON.stringify(initialQuery));
    const href = sp.toString() ? `/inventory?${sp.toString()}` : "/inventory";
    if (isDirty) {
      guardedNavigate(href);
      return;
    }
    router.push(href);
  }

  return (
    <div className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-gray-50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[12px] font-bold text-gray-700">詳細検索</h2>
        <button type="button" onClick={closePanel} className="text-[11px] text-gray-400 hover:text-gray-700">
          閉じる
        </button>
      </div>

      <div className="mb-2 flex items-center gap-2 border border-gray-200 bg-white p-2">
        <span className="text-[11px] text-gray-500">条件の組み合わせ:</span>
        <div className="flex border border-gray-300">
          <button
            type="button"
            onClick={() => setCombinator("AND")}
            className={`px-2 py-0.5 text-[12px] ${combinator === "AND" ? "bg-gray-900 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            AND（すべて）
          </button>
          <button
            type="button"
            onClick={() => setCombinator("OR")}
            className={`border-l border-gray-300 px-2 py-0.5 text-[12px] ${combinator === "OR" ? "bg-gray-900 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            OR（いずれか）
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {conditions.map((condition, index) => (
          <ConditionRow
            key={condition.id}
            index={index}
            condition={condition}
            fieldsByGroup={fieldsByGroup}
            fieldsByKey={fieldsByKey}
            onChangeField={(key) => handleFieldChange(condition.id, key)}
            onChangeOperator={(op) => updateCondition(condition.id, { operator: op, value: undefined, value2: undefined })}
            onChangeValue={(value) => updateCondition(condition.id, { value })}
            onChangeValue2={(value2) => updateCondition(condition.id, { value2 })}
            onRemove={() => removeCondition(condition.id)}
            removable={conditions.length > 1}
          />
        ))}
      </div>

      <button type="button" onClick={addCondition} className="mt-2 w-full border border-dashed border-gray-300 py-1.5 text-[12px] text-gray-500 hover:border-gray-400 hover:text-gray-800">
        ＋ 条件を追加
      </button>

      <div className="mt-3 flex gap-2">
        <button type="button" onClick={submit} className="flex-1 bg-gray-900 py-1.5 text-[13px] text-white hover:bg-gray-800">
          検索
        </button>
        <button type="button" onClick={reset} className="border border-gray-300 px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-100">
          リセット
        </button>
      </div>
    </div>
  );
}

interface ConditionRowProps {
  index: number;
  condition: AdvancedSearchCondition;
  fieldsByGroup: Map<string, SearchFieldDef[]>;
  fieldsByKey: Map<string, SearchFieldDef>;
  onChangeField: (key: string) => void;
  onChangeOperator: (op: AdvancedSearchCondition["operator"]) => void;
  onChangeValue: (value: string) => void;
  onChangeValue2: (value: string) => void;
  onRemove: () => void;
  removable: boolean;
}

const selectClass = "w-full border border-gray-300 bg-white px-1.5 py-1 text-[12px] focus:border-gray-500 focus:outline-none";
const inputClass = "w-full border border-gray-300 px-1.5 py-1 text-[12px] focus:border-gray-500 focus:outline-none";

function ConditionRow({
  index,
  condition,
  fieldsByGroup,
  fieldsByKey,
  onChangeField,
  onChangeOperator,
  onChangeValue,
  onChangeValue2,
  onRemove,
  removable,
}: ConditionRowProps) {
  const field = fieldsByKey.get(condition.field);
  const operators = field ? operatorsForType(field.valueType) : [];
  const needsValue = !operatorNeedsNoValue(condition.operator);
  const needsSecondValue = operatorNeedsSecondValue(condition.operator);

  return (
    <div className="border border-gray-200 bg-white p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-bold text-gray-400">条件 {index + 1}</span>
        {removable && (
          <button type="button" onClick={onRemove} className="text-[11px] text-gray-400 hover:text-red-600" aria-label={`条件${index + 1}を削除`}>
            ✕ 削除
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        <select value={condition.field} onChange={(e) => onChangeField(e.target.value)} className={selectClass}>
          {[...fieldsByGroup.entries()].map(([group, fields]) => (
            <optgroup key={group} label={group}>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <select value={condition.operator} onChange={(e) => onChangeOperator(e.target.value as AdvancedSearchCondition["operator"])} className={selectClass}>
          {operators.map((op) => (
            <option key={op.value} value={op.value}>
              {op.label}
            </option>
          ))}
        </select>

        {needsValue && field && (
          <ValueInput field={field} value={condition.value ?? ""} onChange={onChangeValue} label={needsSecondValue ? "開始" : undefined} />
        )}
        {needsValue && needsSecondValue && field && (
          <ValueInput field={field} value={condition.value2 ?? ""} onChange={onChangeValue2} label="終了" />
        )}
      </div>
    </div>
  );
}

function ValueInput({
  field,
  value,
  onChange,
  label,
}: {
  field: SearchFieldDef;
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const wrap = (input: React.ReactNode) =>
    label ? (
      <div className="flex items-center gap-1.5">
        <span className="w-8 shrink-0 text-[11px] text-gray-400">{label}</span>
        {input}
      </div>
    ) : (
      input
    );

  if (field.valueType === "category" || field.valueType === "location" || field.valueType === "status" || field.valueType === "select") {
    return wrap(
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value="">選択してください</option>
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>,
    );
  }

  if (field.valueType === "date" || field.valueType === "datetime") {
    return wrap(<DateField value={value} onChange={onChange} className={inputClass} />);
  }

  if (field.valueType === "number") {
    return wrap(<input type="number" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} placeholder="数値" />);
  }

  return wrap(<input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} placeholder="値" />);
}
