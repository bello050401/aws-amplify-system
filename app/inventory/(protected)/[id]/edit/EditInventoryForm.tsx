"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { remove } from "aws-amplify/storage";
import { updateInventory, type ImageSlotInput } from "@/app/actions/inventory";
import { LabeledInput, LabeledSelect, CustomFieldInput } from "../../FormFields";
import { ImageEditor, imageEditorHasError, imageEditorHasUploading, type ImageEditorSlot } from "../../../ImageEditor";
import { ExtendedFieldsSection } from "../../ExtendedFieldsSection";
import { useUnsavedChanges } from "../../../UnsavedChangesProvider";
import { buildFormDirtySnapshot, discardUnsavedNewImages } from "../../../formDirtySnapshot";
import {
  INVENTORY_EXTENDED_SECTIONS,
  SALES_SECTION_ID,
  USED_GOODS_LEDGER_SECTION_ID,
  extendedValuesFromRecord,
  parseExtendedValues,
} from "@/lib/inventory/extendedFields";
import { splitImagesByType, type InventoryImageRecord } from "@/lib/inventory/imageTypes";
import type { CustomFieldDefinitionRow, InventoryDetail, MasterOption, StatusOption } from "@/lib/inventory/queries";

interface EditInventoryFormProps {
  item: InventoryDetail;
  categories: MasterOption[];
  locations: MasterOption[];
  statuses: StatusOption[];
  customFieldDefs: CustomFieldDefinitionRow[];
  /** 単位マスタ(夜間開発指示書 §10)の有効な名称一覧 — 単位欄のdatalist候補。 */
  units: string[];
}

/**
 * item.images (both types mixed, as stored) → this session's editable
 * "existing" slot list for one group. Mirrors NewInventoryForm's
 * slotsFromImages, but "existing" kind (nothing to copy — this record
 * already owns these S3 objects) rather than "copy". `sourceSystem`/
 * `sourceUrl` are carried straight through from the stored record — an
 * untouched ZAICO-imported image keeps its tag across a plain
 * edit-and-save, which is what lets the next ZAICO sync still recognize
 * it as "its" image (see lib/inventory/zaicoSync.ts).
 */
function slotsFromExistingImages(images: InventoryImageRecord[]): ImageEditorSlot[] {
  return images.map((img) => ({
    id: crypto.randomUUID(),
    kind: "existing" as const,
    storageKey: img.storageKey,
    isPrimary: img.isPrimary,
    sourceSystem: img.sourceSystem,
    sourceUrl: img.sourceUrl,
    thumbnailKey: img.thumbnailKey,
    originalHash: img.originalHash,
    classification: img.classification,
  }));
}

/** Same flattening NewInventoryForm uses at submit time — see that file's identical function for the full comment. */
function slotsToImageInputs(slots: ImageEditorSlot[], type: "NORMAL" | "DAMAGE"): ImageSlotInput[] {
  return slots.map((slot, idx) => {
    const isPrimary = type === "NORMAL" && slot.isPrimary;
    return slot.kind === "copy"
      ? {
          kind: "copy",
          sourceStorageKey: slot.sourceStorageKey,
          sortOrder: idx,
          type,
          isPrimary,
          sourceSystem: slot.sourceSystem,
          sourceUrl: slot.sourceUrl,
          sourceThumbnailKey: slot.sourceThumbnailKey,
          sourceOriginalHash: slot.sourceOriginalHash,
          sourceClassification: slot.sourceClassification,
        }
      : {
          kind: "uploaded",
          storageKey: slot.storageKey as string,
          sortOrder: idx,
          type,
          isPrimary,
          sourceSystem: slot.sourceSystem,
          sourceUrl: slot.sourceUrl,
          thumbnailKey: slot.thumbnailKey,
          originalHash: slot.originalHash,
          classification: slot.classification,
        };
  });
}

/**
 * Same fields as NewInventoryForm, minus 在庫ID (shown read-only — it's
 * the system-issued identifier, spec explicitly rules out editing it
 * here; internally still `sku`, only the UI label changed for Phase C).
 * Shares LabeledInput/LabeledSelect/CustomFieldInput and ImageEditor with
 * the registration form; see ImageEditor.tsx for why an edit's images
 * start as "existing" slots rather than "new"/"copy" ones — nothing here
 * re-uploads or copies an image the user just leaves alone. Phase C.5:
 * 商品画像(normal)/傷・汚れ写真(damage) are two independent slot
 * lists/ImageEditor instances, split from `item.images` on load and
 * re-flattened (type-tagged, isPrimary included) at submit — see
 * NewInventoryForm's identical structure for the full reasoning.
 *
 * Phase C's ~30 extended fields are rendered by ExtendedFieldsSection
 * from lib/inventory/extendedFields.ts's shared config — the exact same
 * component and config NewInventoryForm uses, so those field
 * definitions exist in exactly one place (spec §5).
 */
export function EditInventoryForm({ item, categories, locations, statuses, customFieldDefs, units }: EditInventoryFormProps) {
  const router = useRouter();
  const [name, setName] = useState(item.name);
  const [categoryId, setCategoryId] = useState(item.categoryId ?? "");
  const [statusId, setStatusId] = useState(item.statusId ?? "");
  const [locationId, setLocationId] = useState(item.locationId ?? "");
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [unit, setUnit] = useState(item.unit ?? "");
  const [purchasePrice, setPurchasePrice] = useState(item.purchasePrice != null ? String(item.purchasePrice) : "");
  const [salePrice, setSalePrice] = useState(item.salePrice != null ? String(item.salePrice) : "");
  const [barcode, setBarcode] = useState(item.barcode ?? "");
  const [note, setNote] = useState(item.note ?? "");
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(item.customFields ?? {}).map(([k, v]) => [k, String(v ?? "")])),
  );
  const [extendedValues, setExtendedValues] = useState<Record<string, string>>(extendedValuesFromRecord(item));
  const { normal: initialNormal, damage: initialDamage } = splitImagesByType(item.images);
  const [normalImageSlots, setNormalImageSlots] = useState<ImageEditorSlot[]>(slotsFromExistingImages(initialNormal));
  const [damageImageSlots, setDamageImageSlots] = useState<ImageEditorSlot[]>(slotsFromExistingImages(initialDamage));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 未保存変更ガード (spec I-N) — NewInventoryFormと同一のロジック。
  // buildFormDirtySnapshotが単一の比較対象としてすべてのフィールド
  // (画像含む)をまとめる — 個別管理しない(spec J)。
  const { setDirty, registerSaveHandler, registerDiscardHandler, guardedNavigate } = useUnsavedChanges();
  const initialSnapshotRef = useRef<string | null>(null);
  const currentSnapshot = buildFormDirtySnapshot({
    name,
    categoryId,
    statusId,
    locationId,
    quantity,
    unit,
    purchasePrice,
    salePrice,
    barcode,
    note,
    customFieldValues,
    extendedValues,
    normalImageSlots,
    damageImageSlots,
  });
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = currentSnapshot;
  const isDirty = currentSnapshot !== initialSnapshotRef.current;

  useEffect(() => {
    setDirty(isDirty);
  }, [isDirty, setDirty]);

  function handleCustomFieldChange(fieldKey: string, value: string) {
    setCustomFieldValues((prev) => ({ ...prev, [fieldKey]: value }));
  }

  function handleExtendedFieldChange(key: string, value: string) {
    setExtendedValues((prev) => ({ ...prev, [key]: value }));
  }

  /** Same role as NewInventoryForm's attemptSave — see that file's comment. */
  async function attemptSave(): Promise<{ success: boolean }> {
    setError(null);
    if (!name.trim()) {
      setError("商品名を入力してください。");
      return { success: false };
    }
    if (imageEditorHasUploading(normalImageSlots) || imageEditorHasUploading(damageImageSlots)) {
      setError("画像のアップロード完了までお待ちください。");
      return { success: false };
    }
    if (imageEditorHasError(normalImageSlots) || imageEditorHasError(damageImageSlots)) {
      setError("アップロードに失敗した画像があります。該当の画像を削除するか、再度選択し直してください。");
      return { success: false };
    }
    for (const def of customFieldDefs) {
      if (def.required && !customFieldValues[def.fieldKey]?.trim()) {
        setError(`「${def.label}」は必須項目です。`);
        return { success: false };
      }
    }

    setSubmitting(true);
    try {
      const customFields: Record<string, unknown> = {};
      for (const def of customFieldDefs) {
        const raw = customFieldValues[def.fieldKey];
        if (raw === undefined || raw === "") continue;
        customFields[def.fieldKey] = def.fieldType === "NUMBER" ? Number(raw) : raw;
      }

      const images: ImageSlotInput[] = [...slotsToImageInputs(normalImageSlots, "NORMAL"), ...slotsToImageInputs(damageImageSlots, "DAMAGE")];

      await updateInventory(
        item.id,
        {
          name,
          categoryId: categoryId || undefined,
          statusId: statusId || undefined,
          locationId: locationId || undefined,
          quantity: quantity ? Number(quantity) : 0,
          unit: unit || undefined,
          purchasePrice: purchasePrice ? Number(purchasePrice) : undefined,
          salePrice: salePrice ? Number(salePrice) : undefined,
          barcode: barcode || undefined,
          note: note || undefined,
          images,
          customFields,
          ...parseExtendedValues(extendedValues),
        },
        { skipRedirect: true },
      );
      setDirty(false);
      return { success: true };
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新に失敗しました。");
      return { success: false };
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    registerSaveHandler(async () => attemptSave());
    registerDiscardHandler(() => {
      discardUnsavedNewImages(normalImageSlots, (path) => remove({ path }));
      discardUnsavedNewImages(damageImageSlots, (path) => remove({ path }));
    });
  });
  useEffect(() => {
    return () => {
      registerSaveHandler(null);
      registerDiscardHandler(null);
      setDirty(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = await attemptSave();
    if (result.success) {
      router.push(`/inventory/${item.id}`);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      // BELLO統合改修 master指示書 Phase C — the edit screen only,
      // redesigned as: 画像(左) / 大きな単一カラムフォーム(中央) / 付加
      // 情報(右、任意) on desktop, all stacked in that same order
      // (画像→フォーム) on mobile via the plain grid-cols-1 default
      // below lg:. The detail/view screen (app/inventory/(protected)/
      // [id]/page.tsx) and the new-registration screen
      // (NewInventoryForm.tsx) are completely untouched by this Phase —
      // every size/layout change here lives in THIS file (plus the
      // `size`/`columns` props FormFields.tsx/ExtendedFieldsSection.tsx
      // gained, both defaulting to their exact pre-Phase-C look) and
      // nowhere else.
      className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_minmax(0,1fr)_260px] lg:items-start"
    >
      {/* 単位欄のdatalist候補(夜間開発指示書 §10) — 自由入力のまま、単位マスタの値を候補として提示する。 */}
      <datalist id="unit-options">
        {units.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>

      {/* タイトルはInventoryHeader側(edit/page.tsx)に表示済み — ここでは
          未保存変更ガードを経由する「詳細へ戻る」だけを残す。全カラムの
          上に1本だけ表示する。 */}
      <div className="flex items-center justify-end lg:col-span-3">
        <button type="button" onClick={() => guardedNavigate(`/inventory/${item.id}`)} className="text-[12px] text-gray-500 hover:text-gray-900">
          詳細へ戻る
        </button>
      </div>

      {/* 左カラム: 画像(商品画像/傷・汚れ写真)。参照レイアウト通り、
          フォームの左に固定幅で配置 — モバイルでは(grid-cols-1により)
          フォームより先に単純に積まれる("image then form")。 */}
      <div className="space-y-4 lg:col-start-1">
        <div className="border border-gray-200 p-4">
          <p className="mb-2 text-[11px] font-bold text-gray-400">商品画像</p>
          <ImageEditor slots={normalImageSlots} onChange={setNormalImageSlots} variant="normal" />
        </div>
        <div className="border border-gray-200 p-4">
          <p className="mb-2 text-[11px] font-bold text-gray-400">傷・汚れ写真</p>
          <ImageEditor slots={damageImageSlots} onChange={setDamageImageSlots} variant="damage" />
        </div>
      </div>

      {/* 中央カラム: 大きな入力欄の単一カラムフォーム(master指示書
          Phase C: 16-17px/高さ44-48px、基本情報・追加項目とも単一カラ
          ム)。size="large"は既存のLabeledInput/LabeledSelect/
          CustomFieldInput/ExtendedFieldsSectionへ追加したオプション引
          数 — 既定値"compact"のNewInventoryForm.tsxの見た目は一切変わ
          らない。 */}
      <div className="lg:col-start-2">
        <p className="mb-3 text-[11px] font-bold text-gray-400">基本情報</p>
        <div className="grid grid-cols-1 gap-4">
          <LabeledInput label="物品名" required value={name} onChange={setName} size="large" />
          <LabeledSelect
            label="カテゴリ"
            value={categoryId}
            onChange={setCategoryId}
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
            size="large"
          />
          <LabeledSelect
            label="保管場所"
            value={locationId}
            onChange={setLocationId}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            size="large"
          />
          <LabeledSelect label="状態" value={statusId} onChange={setStatusId} options={statuses.map((s) => ({ value: s.id, label: s.label }))} size="large" />

          <div className="grid grid-cols-2 gap-4">
            <LabeledInput label="数量" type="number" value={quantity} onChange={setQuantity} size="large" />
            <LabeledInput label="単位" value={unit} onChange={setUnit} placeholder="個" list="unit-options" size="large" />
          </div>
          <LabeledInput label="QRコード・バーコード" value={barcode} onChange={setBarcode} size="large" />

          <div>
            <label className="block text-[12px] text-gray-600">備考</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={5}
              className="mt-0.5 w-full border border-gray-300 px-2.5 py-2.5 text-[16px] focus:border-gray-500 focus:outline-none"
            />
          </div>
        </div>

        {customFieldDefs.length > 0 && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <p className="mb-3 text-[11px] font-bold text-gray-400">追加項目</p>
            <div className="grid grid-cols-1 gap-4">
              {customFieldDefs.map((def) => (
                <CustomFieldInput
                  key={def.id}
                  def={def}
                  value={customFieldValues[def.fieldKey] ?? ""}
                  onChange={(v) => handleCustomFieldChange(def.fieldKey, v)}
                  size="large"
                  fullWidthClassName="" // 単一カラムなのでcol-span-2は不要(意味を持たない)
                />
              ))}
            </div>
          </div>
        )}

        {/* Phase C: 販売情報 / サイズ・商品仕様 / コンディション / 仕入・
            古物台帳 / 管理メモ — see NewInventoryForm's identical block
            for why purchasePrice/salePrice are injected into their
            spec-mandated sections via `extra` rather than being part of
            the shared config. columns={1}/size="large"はこの画面専用。 */}
        {INVENTORY_EXTENDED_SECTIONS.map((section) => (
          <ExtendedFieldsSection
            key={section.id}
            section={section}
            values={extendedValues}
            onChange={handleExtendedFieldChange}
            size="large"
            columns={1}
            extra={
              section.id === SALES_SECTION_ID ? (
                <LabeledInput label="販売価格（成約）" type="number" value={salePrice} onChange={setSalePrice} placeholder="円" size="large" />
              ) : section.id === USED_GOODS_LEDGER_SECTION_ID ? (
                // 追加修正指示 §9-§11: NewInventoryForm.tsxと同じ理由でラ
                // ベルのみ「購入価格」→「原価」に変更(フィールド/値/schema
                // は不変)。同ファイルのコメント参照。
                <LabeledInput
                  label="原価"
                  type="number"
                  value={purchasePrice}
                  onChange={setPurchasePrice}
                  placeholder="円（送料等込みの最終原価）"
                  size="large"
                />
              ) : undefined
            }
          />
        ))}

        {error && <p className="mt-4 text-[13px] text-red-600">{error}</p>}

        <div className="mt-6 flex gap-2">
          <button
            type="submit"
            disabled={submitting || imageEditorHasUploading(normalImageSlots) || imageEditorHasUploading(damageImageSlots)}
            className="bg-gray-900 px-5 py-3 text-[15px] font-bold text-white disabled:opacity-50"
          >
            {submitting ? "保存中…" : "保存する"}
          </button>
          <button
            type="button"
            onClick={() => guardedNavigate(`/inventory/${item.id}`)}
            className="border border-gray-300 px-5 py-3 text-[15px] text-gray-700"
          >
            キャンセル
          </button>
        </div>
      </div>

      {/* 右カラム(任意・補足情報) — 在庫ID/SKU/ZAICO連携状況/登録・更新
          日時。読み取り専用の表示のみで、フォームの状態やバリデーショ
          ンには一切関わらない。参照レイアウトの「右=補足情報」に対応
          — デスクトップでは追従表示(sticky)、モバイルではフォームの
          後ろに単純に積まれる。 */}
      <div className="lg:col-start-3">
        <div className="border border-gray-200 p-4 lg:sticky lg:top-4">
          <p className="mb-2 text-[11px] font-bold text-gray-400">付加情報</p>
          <dl className="space-y-2 text-[12px] text-gray-600">
            <div>
              <dt className="text-gray-400">在庫ID</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-gray-700">{item.displayId}</dd>
            </div>
            <div>
              <dt className="text-gray-400">SKU</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-gray-700">{item.sku}</dd>
            </div>
            {item.sourceSystem === "ZAICO" && (
              <div>
                <dt className="text-gray-400">連携元</dt>
                <dd className="mt-0.5 text-[13px] text-gray-700">ZAICO（ID: {item.sourceInventoryId}）</dd>
              </div>
            )}
            <div>
              <dt className="text-gray-400">登録日時</dt>
              <dd className="mt-0.5 text-[13px] text-gray-700">{formatDateTime(item.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-gray-400">更新日時</dt>
              <dd className="mt-0.5 text-[13px] text-gray-700">{formatDateTime(item.updatedAt)}</dd>
            </div>
          </dl>
        </div>
      </div>
    </form>
  );
}

/**
 * 詳細画面(app/inventory/(protected)/[id]/page.tsx)にも同名・同実装
 * の関数があるが、意図的に共有モジュールへ切り出していない — master
 * 指示書 Phase Cの絶対制約「詳細画面はこのフェーズで一切変更しない」
 * を守るため、詳細画面のファイル自体には一切手を加えない(このヘルパー
 * を切り出して詳細画面側の import 文を書き換えることさえしない)。3行
 * の純粋関数を2箇所に持つ方が、詳細画面のdiffをゼロに保つより安全。
 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
