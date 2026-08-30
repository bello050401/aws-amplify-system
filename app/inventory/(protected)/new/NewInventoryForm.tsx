"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { remove } from "aws-amplify/storage";
import { createInventory, type ImageSlotInput } from "@/app/actions/inventory";
import { LabeledInput, LabeledSelect, CustomFieldInput } from "../FormFields";
import { ImageEditor, imageEditorHasError, imageEditorHasUploading, type ImageEditorSlot } from "../../ImageEditor";
import { ExtendedFieldsSection } from "../ExtendedFieldsSection";
import { useUnsavedChanges } from "../../UnsavedChangesProvider";
import { buildFormDirtySnapshot, discardUnsavedNewImages } from "../../formDirtySnapshot";
import {
  INVENTORY_EXTENDED_SECTIONS,
  SALES_SECTION_ID,
  USED_GOODS_LEDGER_SECTION_ID,
  extendedValuesFromRecord,
  parseExtendedValues,
  type InventoryExtendedFields,
} from "@/lib/inventory/extendedFields";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import type { CustomFieldDefinitionRow, MasterOption, StatusOption } from "@/lib/inventory/queries";

interface DuplicateSource extends InventoryExtendedFields {
  sourceDisplayId: string;
  name: string;
  categoryId?: string;
  statusId?: string;
  locationId?: string;
  quantity?: number;
  unit?: string;
  purchasePrice?: number;
  salePrice?: number;
  note?: string;
  barcode?: string | null;
  customFields?: Record<string, unknown>;
  normalImages: InventoryImageRecord[];
  damageImages: InventoryImageRecord[];
}

/**
 * duplicateFrom's saved images (isPrimary already resolved server-side,
 * see new/page.tsx) → this session's editable slot list. Shared by both
 * the normal and damage seeding below. `sourceSystem`/`sourceUrl` are
 * deliberately forced to null here — even if the source image was ZAICO-
 * imported, a duplicated record is a brand-new, non-ZAICO-managed
 * Inventory (it has no sourceInventoryId of its own), so its copied image
 * must not carry a ZAICO tag the sync engine would try to match against.
 */
function slotsFromImages(images: InventoryImageRecord[]): ImageEditorSlot[] {
  return images.map((img) => ({
    id: crypto.randomUUID(),
    kind: "copy" as const,
    sourceStorageKey: img.storageKey,
    isPrimary: img.isPrimary,
    sourceSystem: null,
    sourceUrl: null,
    sourceThumbnailKey: img.thumbnailKey,
    sourceOriginalHash: img.originalHash,
    sourceClassification: img.classification,
  }));
}

/**
 * The inverse, at submit time: this session's slot list → the flat,
 * type-tagged payload createInventory expects. sortOrder is the slot's
 * position within ITS OWN list (normal and damage are numbered
 * independently — see amplify/data/resource.ts's InventoryImage
 * comment). isPrimary is forced false for damage images regardless of
 * the slot's own field — the damage ImageEditor's UI never offers a way
 * to set it, but this is the one place that would matter if it somehow
 * were, since a damage photo must never become the top image.
 */
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

interface NewInventoryFormProps {
  categories: MasterOption[];
  locations: MasterOption[];
  statuses: StatusOption[];
  customFieldDefs: CustomFieldDefinitionRow[];
  /** 単位マスタ(夜間開発指示書 §10)の有効な名称一覧 — 単位欄のdatalist候補。既存の自由入力(Inventory.unitは今回もschema変更なしの文字列のまま)を壊さず、候補を提示するだけ。 */
  units: string[];
  duplicateFrom?: DuplicateSource;
}

/**
 * Multi-image upload (spec §6/§30) is delegated to the shared ImageEditor
 * (app/inventory/ImageEditor.tsx), rendered TWICE — once for 商品画像
 * (normal), once for 傷・汚れ写真 (damage) — as two fully independent
 * slot lists/states (Phase C.5 §3/§8: two clearly separate upload areas,
 * one shared component, not a second copy of it). Each list's own array
 * position is that group's sortOrder; the normal group additionally
 * tracks an explicit `isPrimary` per slot (spec §4's "トップ画像"),
 * decoupled from position — see ImageEditor.tsx's resolveTopSlot. Both
 * lists are flattened into one type-tagged array (slotsToImageInputs)
 * only at submit time, matching how amplify/data/resource.ts's
 * InventoryImage customType actually stores them.
 *
 * `duplicateFrom` (set by new/page.tsx from ?duplicateFrom=<id>) seeds
 * every field except SKU from the source record, per spec: SKU always
 * comes fresh from generateInventorySku on submit, same as any other
 * registration — never the source's. Its images (both groups, isPrimary
 * included) become "copy" slots, not "uploaded" ones, so submitting this
 * form copies them to brand-new S3 objects rather than pointing two
 * Inventory records at the same key.
 *
 * Phase C's ~30 extended fields (販売情報/サイズ・商品仕様/コンディシ
 * ョン/仕入・古物台帳/管理メモ) are NOT hand-written here one by one —
 * they're driven entirely by lib/inventory/extendedFields.ts's shared
 * config via ExtendedFieldsSection, the exact same component
 * EditInventoryForm uses, so the ~30 field definitions exist in exactly
 * one place (spec §5).
 */
export function NewInventoryForm({ categories, locations, statuses, customFieldDefs, units, duplicateFrom }: NewInventoryFormProps) {
  const router = useRouter();
  const [name, setName] = useState(duplicateFrom?.name ?? "");
  const [categoryId, setCategoryId] = useState(duplicateFrom?.categoryId ?? "");
  const [statusId, setStatusId] = useState(duplicateFrom?.statusId ?? "");
  const [locationId, setLocationId] = useState(duplicateFrom?.locationId ?? "");
  const [quantity, setQuantity] = useState(String(duplicateFrom?.quantity ?? 1));
  const [unit, setUnit] = useState(duplicateFrom?.unit ?? "");
  const [purchasePrice, setPurchasePrice] = useState(duplicateFrom?.purchasePrice != null ? String(duplicateFrom.purchasePrice) : "");
  const [salePrice, setSalePrice] = useState(duplicateFrom?.salePrice != null ? String(duplicateFrom.salePrice) : "");
  const [barcode, setBarcode] = useState(duplicateFrom?.barcode ?? "");
  const [note, setNote] = useState(duplicateFrom?.note ?? "");
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(duplicateFrom?.customFields ?? {}).map(([k, v]) => [k, String(v ?? "")])),
  );
  const [extendedValues, setExtendedValues] = useState<Record<string, string>>(extendedValuesFromRecord(duplicateFrom ?? {}));
  const [normalImageSlots, setNormalImageSlots] = useState<ImageEditorSlot[]>(slotsFromImages(duplicateFrom?.normalImages ?? []));
  const [damageImageSlots, setDamageImageSlots] = useState<ImageEditorSlot[]>(slotsFromImages(duplicateFrom?.damageImages ?? []));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 未保存変更ガード (spec I-N)。dirty = 初期値(マウント時の1回だけ)
  // ≠ 現在値。buildFormDirtySnapshotはtext/number/date/select/custom
  // fields/画像(追加・削除・NORMAL⇄DAMAGE・並び替え・トップ画像変更)を
  // すべて一つの比較対象に含む — 個別のフィールドごとにdirtyを管理しな
  // い(spec J)。
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

  /**
   * The actual save attempt — used by BOTH the plain "登録する" submit
   * button below AND, via registerSaveHandler, the 未保存変更ガードの
   * 「保存して移動」(spec I-3). Deliberately does no navigation itself:
   * createInventory is called with `{ skipRedirect: true }` so it just
   * returns the new record's id instead of redirect()ing to it, and the
   * CALLER decides where to go next — the plain button always goes to
   * the new record's own page (unchanged observable behavior); the guard
   * goes to wherever the user was actually trying to navigate.
   */
  async function attemptSave(): Promise<{ success: boolean; id?: string }> {
    setError(null);
    if (!name.trim()) {
      setError("商品名を入力してください。");
      return { success: false };
    }
    if (imageEditorHasUploading(normalImageSlots) || imageEditorHasUploading(damageImageSlots)) {
      setError("画像のアップロード完了までお待ちください。");
      return { success: false };
    }
    // A failed upload must not be silently dropped from the submission —
    // that previously let a registration "succeed" with zero images and
    // no clear signal why.
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

      const created = await createInventory(
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
      return { success: true, id: created.id };
    } catch (err) {
      setError(err instanceof Error ? err.message : "登録に失敗しました。");
      return { success: false };
    } finally {
      setSubmitting(false);
    }
  }

  // K: 保存後はdirtyを解除し(attemptSave内でsetDirty(false)済み)、以降
  // のナビゲーションで確認を出さない。ページ離脱(このコンポーネントの
  // unmount)時にも、保存を経ずに離れた場合の後始末として登録解除・
  // dirty解除を行う。
  useEffect(() => {
    registerSaveHandler(async () => {
      const result = await attemptSave();
      return { success: result.success };
    });
    registerDiscardHandler(() => {
      // L: 「保存せず移動」— このセッションでアップロード済みだが未保存
      // の画像を、大量の孤児S3ファイルを残さない範囲でベストエフォート
      // 削除する。
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
    if (result.success && result.id) {
      router.push(`/inventory/${result.id}`);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-3xl">
      {/* 単位欄のdatalist候補(夜間開発指示書 §10) — 自由入力のまま、単位マスタの値を候補として提示する。 */}
      <datalist id="unit-options">
        {units.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
      {/* タイトルはInventoryHeader側(new/page.tsx)に表示済み — ここでは
          未保存変更ガードを経由する「一覧へ戻る」だけを残す。 */}
      <div className="mb-4 flex items-center justify-end">
        <button
          type="button"
          onClick={() => guardedNavigate("/inventory")}
          className="inline-flex min-h-8 items-center text-[12px] text-gray-500 hover:text-gray-900"
        >
          在庫一覧へ戻る
        </button>
      </div>

      {duplicateFrom && (
        <p className="mb-4 border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-600">
          「{duplicateFrom.sourceDisplayId} {duplicateFrom.name}」の内容を引き継いでいます。在庫IDは登録時に新しく発番されます。内容を確認・修正してから登録してください。
        </p>
      )}

      <p className="mb-2 text-[11px] font-bold text-gray-400">基本情報</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[12px] text-gray-600">在庫ID</label>
          <p className="mt-0.5 border border-gray-200 bg-gray-50 px-2 py-1 text-[13px] text-gray-400">
            登録時に自動採番されます(例: B000001)
          </p>
        </div>
        <LabeledInput label="物品名" required value={name} onChange={setName} />

        <LabeledSelect label="カテゴリ" value={categoryId} onChange={setCategoryId} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        <LabeledSelect label="保管場所" value={locationId} onChange={setLocationId} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
        <LabeledSelect label="状態" value={statusId} onChange={setStatusId} options={statuses.map((s) => ({ value: s.id, label: s.label }))} />

        <div className="grid grid-cols-2 gap-2">
          <LabeledInput label="数量" type="number" value={quantity} onChange={setQuantity} />
          <LabeledInput label="単位" value={unit} onChange={setUnit} placeholder="個" list="unit-options" />
        </div>
        <LabeledInput label="QRコード・バーコード" value={barcode} onChange={setBarcode} />

        <div className="col-span-2">
          <label className="block text-[12px] text-gray-600">備考</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          />
        </div>
      </div>

      {customFieldDefs.length > 0 && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <p className="mb-2 text-[11px] font-bold text-gray-400">追加項目</p>
          <div className="grid grid-cols-2 gap-4">
            {customFieldDefs.map((def) => (
              <CustomFieldInput
                key={def.id}
                def={def}
                value={customFieldValues[def.fieldKey] ?? ""}
                onChange={(v) => handleCustomFieldChange(def.fieldKey, v)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Phase C.5: two clearly separate upload areas (spec §2/§3) — 商品
          画像 is what shows up in the list/detail top image and is the
          future candidate pool for 出品用/補正済み画像 (spec §7);
          傷・汚れ写真 is condition documentation only and can never
          become the top image (see ImageEditor's variant prop). */}
      <div className="mt-4 border-t border-gray-100 pt-4">
        <p className="mb-2 text-[11px] font-bold text-gray-400">商品画像</p>
        <ImageEditor slots={normalImageSlots} onChange={setNormalImageSlots} variant="normal" />
      </div>

      <div className="mt-4 border-t border-gray-100 pt-4">
        <p className="mb-2 text-[11px] font-bold text-gray-400">傷・汚れ写真</p>
        <ImageEditor slots={damageImageSlots} onChange={setDamageImageSlots} variant="damage" />
      </div>

      {/* Phase C: 販売情報 / サイズ・商品仕様 / コンディション / 仕入・
          古物台帳 / 管理メモ, driven entirely by lib/inventory/
          extendedFields.ts's shared config. purchasePrice/salePrice —
          pre-existing fields with their own state above — are injected
          into their spec-mandated sections via `extra`: purchasePrice
          into 仕入・古物台帳 (it IS that ledger's「購入価格」), salePrice
          into 販売情報 (distinct from plannedSalePrice's「販売予定価
          格」) — the same SALES_SECTION_ID/USED_GOODS_LEDGER_SECTION_ID
          the detail page uses for the identical placement, so the two
          can't drift apart on where each one shows up. See
          EditInventoryForm for the identical layout. */}
      {INVENTORY_EXTENDED_SECTIONS.map((section) => (
        <ExtendedFieldsSection
          key={section.id}
          section={section}
          values={extendedValues}
          onChange={handleExtendedFieldChange}
          extra={
            section.id === SALES_SECTION_ID ? (
              <LabeledInput label="販売価格（成約）" type="number" value={salePrice} onChange={setSalePrice} placeholder="円" />
            ) : section.id === USED_GOODS_LEDGER_SECTION_ID ? (
              // 追加修正指示 §9-§11: この欄のラベルを「購入価格」から
              // 「原価」へ変更 — フィールド自体(purchasePrice, schema
              // 不変)・値は一切変えず、表示ラベルのみの変更。BELLOの実
              // 運用方針として、今後はここへ「購入価格+送料等の諸経費
              // 込みの最終的な仕入原価」を直接入力する(送料の別入力欄
              // は撤去済み — extendedFields.ts参照)。今後の利益計算は
              // 売上金額-原価(=purchasePrice)を正とする(§11)。
              // 在庫詳細画面の「古物台帳」表示(法定台帳の記載順が固定の
              // 区画)は、古物営業法上の帳簿表記に合わせて引き続き「購入
              // 価格」のラベルのまま据え置いている — 同じ値を指す表示だ
              // が、法定台帳の用語とBELLOの日常業務用語を意図的に分けた
              // (値・キー自体は完全に同一)。
              <LabeledInput label="原価" type="number" value={purchasePrice} onChange={setPurchasePrice} placeholder="円（送料等込みの最終原価）" />
            ) : undefined
          }
        />
      ))}

      {error && <p className="mt-4 text-[13px] text-red-600">{error}</p>}

      <div className="mt-6 flex gap-2">
        <button
          type="submit"
          disabled={submitting || imageEditorHasUploading(normalImageSlots) || imageEditorHasUploading(damageImageSlots)}
          className="bg-gray-900 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
        >
          {submitting ? "登録中…" : "登録する"}
        </button>
        <button type="button" onClick={() => guardedNavigate("/inventory")} className="border border-gray-300 px-4 py-2 text-[13px] text-gray-700">
          キャンセル
        </button>
      </div>
    </form>
  );
}
