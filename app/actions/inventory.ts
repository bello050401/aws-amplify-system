"use server";

import { revalidatePath } from "next/cache";
import { clearInventoryCountCache } from "@/lib/inventory/inventoryPage";
import { redirect } from "next/navigation";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import {
  canEditInventory,
  canHardDeleteInventory,
  getCurrentInventoryUserEmail,
  getInventoryRole,
} from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail, listCategories, listLocations, listStatuses } from "@/lib/inventory/queries";
import { stringifyCustomFields } from "@/lib/inventory/customFieldsCodec";
import { computeOriginalHashForPath, copyInventoryImage, removeInventoryImage } from "@/lib/inventory/imageServerOps";
import { copyInventoryThumbnail, generateInventoryThumbnail } from "@/lib/inventory/thumbnail";
import { diffField, logInventoryHistory } from "@/lib/inventory/history";
import { ALL_EXTENDED_FIELDS, type InventoryExtendedFields } from "@/lib/inventory/extendedFields";
import type { InventoryImageRecord, InventoryImageType } from "@/lib/inventory/imageTypes";

/**
 * What the client sends for one image slot (see ImageEditor.tsx):
 * - "uploaded": already at its final S3 key (a fresh upload, or an
 *   unchanged "existing" image on an edit) — used as-is.
 * - "copy": borrowed from another Inventory record (duplicate only) —
 *   resolveImages() copies it to a brand-new key before it's ever
 *   written onto this record, so two records never share one S3 object.
 *
 * `type`/`isPrimary` (Phase C.5) ride along on every slot — the client
 * (NewInventoryForm/EditInventoryForm) manages normal and damage photos
 * as two separate ImageEditor instances/lists and flattens them into one
 * array with these tagged on right before calling createInventory/
 * updateInventory; see those forms' submit handlers.
 *
 * `sourceSystem`/`sourceUrl` (ZAICO sync) ride along too, carried straight
 * through from the ImageEditorSlot the client built — see
 * ImageEditor.tsx's ImageEditorSlot comment and EditInventoryForm/
 * NewInventoryForm's slotsToImageInputs for who sets these to non-null
 * (only an untouched "existing" ZAICO-imported slot on an edit) versus
 * always null ("new"/"copy" — a freshly picked file or a duplicated
 * record are never ZAICO's).
 */
export type ImageSlotInput =
  | {
      kind: "uploaded";
      storageKey: string;
      sortOrder: number;
      type: InventoryImageType;
      isPrimary: boolean;
      sourceSystem: string | null;
      sourceUrl: string | null;
      /**
       * BELLO統合改修 master指示書 Phase B優先度5(変更がなければサム
       * ネイル再生成をスキップ) — an untouched "existing" slot (see
       * ImageEditor.tsx) carries the record's current thumbnailKey
       * through unchanged (possibly still null, for a record from before
       * this Phase); a freshly-picked "new" file always sends null,
       * since nothing has generated one yet. null here always means "try
       * to generate one now" below — which is exactly right in both
       * cases: a brand-new upload needs its first thumbnail, and an old
       * pre-backfill image self-heals the next time it's touched. A
       * non-null value here is always trusted as-is and never
       * regenerated.
       */
      thumbnailKey: string | null;
      /** BELLO画像自動加工システム: 既存(未変更)スロットはこの画像の現在のoriginalHash/classificationをそのまま持ち回る(thumbnailKeyと同じ考え方)。真に新規のアップロード(thumbnailKey===nullの場合)は常にnull——resolveImagesがここでハッシュを計算する。 */
      originalHash: string | null;
      classification: string | null;
    }
  | {
      kind: "copy";
      sourceStorageKey: string;
      sortOrder: number;
      type: InventoryImageType;
      isPrimary: boolean;
      sourceSystem: string | null;
      sourceUrl: string | null;
      /** The SOURCE record's thumbnail key, if it has one — resolveImages copies this alongside the original rather than paying for a fresh resize of an image that's by definition unchanged from its source. null means the source has none yet (pre-backfill) — a fresh one is generated from the newly-copied original instead. */
      sourceThumbnailKey: string | null;
      /** BELLO画像自動加工システム: 複製元画像のoriginalHash/classification。中身は複製元と同一バイト列なので、そのまま引き継ぐ(再計算しない)。 */
      sourceOriginalHash: string | null;
      sourceClassification: string | null;
    };

/**
 * Resolves every image slot to its final storageKey/thumbnailKey, copying
 * "copy" slots one at a time (not Promise.all) so that if one copy fails
 * partway through a multi-image duplicate, this can clean up exactly the
 * ones it already made before re-throwing — never leaves orphaned copies
 * behind, and never returns a partial result for the caller to build an
 * Inventory record out of. See createInventory/updateInventory for how
 * this failing is itself handled without leaving a broken/half-created
 * record on their side either.
 */
async function resolveImages(images: ImageSlotInput[]): Promise<InventoryImageRecord[]> {
  const resolved: InventoryImageRecord[] = [];
  const createdKeys: string[] = []; // every original/thumbnail object actually created (copied or freshly generated) in this call — cleaned up on a later failure
  try {
    for (const img of images) {
      if (img.kind === "uploaded") {
        // Non-null already (an untouched existing image with a thumbnail
        // from a prior save) → reuse as-is, no new object created, so
        // nothing to add to createdKeys for it. Null → attempt to
        // generate one now (see the ImageSlotInput comment above for why
        // this single check correctly covers both "brand new upload" and
        // "self-heal a pre-backfill existing image").
        const thumbnailKey = img.thumbnailKey ?? (await generateInventoryThumbnail(img.storageKey));
        if (!img.thumbnailKey && thumbnailKey) createdKeys.push(thumbnailKey);
        // BELLO画像自動加工システム: thumbnailKeyと全く同じ判定
        // (nullなら「真に新規、または自己修復対象の既存画像」)で
        // originalHashも未計算なら今ここで計算する——新規アップロード
        // ジョブ登録(triggerImageProcessingIfNeeded)がこの値を要求する。
        const originalHash = img.originalHash ?? (await computeOriginalHashForPath(img.storageKey));
        resolved.push({
          storageKey: img.storageKey,
          sortOrder: img.sortOrder,
          type: img.type,
          isPrimary: img.isPrimary,
          sourceSystem: img.sourceSystem,
          sourceUrl: img.sourceUrl,
          thumbnailKey,
          originalHash,
          classification: (img.classification as InventoryImageRecord["classification"]) ?? null,
        });
        continue;
      }
      const newKey = await copyInventoryImage(img.sourceStorageKey);
      createdKeys.push(newKey);
      const thumbnailKey = img.sourceThumbnailKey
        ? await copyInventoryThumbnail(img.sourceThumbnailKey)
        : await generateInventoryThumbnail(newKey);
      if (thumbnailKey) createdKeys.push(thumbnailKey);
      resolved.push({
        storageKey: newKey,
        sortOrder: img.sortOrder,
        type: img.type,
        isPrimary: img.isPrimary,
        sourceSystem: img.sourceSystem,
        sourceUrl: img.sourceUrl,
        thumbnailKey,
        // 複製元と全く同じバイト列なのでoriginalHashもそのまま引き継ぐ
        // (§11.4 冪等性——複製直後に再加工ジョブが二重で走ることはない)。
        originalHash: img.sourceOriginalHash,
        classification: (img.sourceClassification as InventoryImageRecord["classification"]) ?? null,
      });
    }
    return resolved;
  } catch (err) {
    await Promise.allSettled(createdKeys.map((k) => removeInventoryImage(k)));
    throw err; // copyInventoryImage already attaches a specific, user-facing message
  }
}

/** Every S3 object a set of images actually owns — original AND thumbnail (when present) — flattened for a single Promise.allSettled cleanup call. Used by every "these images are gone now, delete their objects" site below (create/update rollback, an edit's removed images, hard delete) so none of them forget the thumbnail half of Phase B's original/thumbnail pair. */
function allImageStorageKeys(images: InventoryImageRecord[]): string[] {
  return images.flatMap((img) => (img.thumbnailKey ? [img.storageKey, img.thumbnailKey] : [img.storageKey]));
}

/**
 * Picks out just the Phase C extended fields from an InventoryFieldsInput
 * — NOT `{ ...input }`, which would also carry `images`/`customFields`
 * in their raw client-submitted shapes (not the resolved storageKeys /
 * stringified JSON the create/update calls below build separately) and
 * clobber those. Every field is always assigned (missing/undefined
 * becomes explicit `null`) rather than only the ones actually provided
 * — see parseExtendedValues' own comment: this is what lets clearing a
 * field in the edit form actually clear it in the database, since
 * Amplify's `.update()` only touches fields it's explicitly given.
 * Harmless on createInventory, where there's no previous value to clear.
 */
function extendedFieldsInput(input: InventoryExtendedFields): Partial<InventoryExtendedFields> {
  const result: Record<string, string | number | null> = {};
  for (const field of ALL_EXTENDED_FIELDS) {
    result[field.key] = input[field.key] ?? null;
  }
  return result as Partial<InventoryExtendedFields>;
}

export interface InventoryFieldsInput extends InventoryExtendedFields {
  name: string;
  categoryId?: string;
  statusId?: string;
  locationId?: string;
  quantity?: number;
  unit?: string;
  purchasePrice?: number;
  salePrice?: number;
  note?: string;
  images: ImageSlotInput[];
  customFields?: Record<string, unknown>;
}

/**
 * Every write below passes `inventoryAuthMode` — Inventory-area models
 * carry no `allow.publicApiKey()` rule at all (see amplify/data/resource.ts),
 * so a call without it is rejected outright, not just falling back to a
 * degraded path. See lib/amplify/dataClient.ts for why this constant is
 * kept separate from Feature's `adminAuthMode`.
 */
/**
 * Two call shapes:
 * - `createInventory(input)` — the plain registration-form submit path,
 *   unchanged from before: always redirects to the new record's page on
 *   success, never returns.
 * - `createInventory(input, { skipRedirect: true })` — used by the
 *   未保存変更ガード (lib/inventory/unsavedChanges.tsx)'s "保存して移動"
 *   flow, which needs to navigate to wherever the user was ACTUALLY
 *   headed (e.g. `/inventory` from a logo click), not unconditionally to
 *   the new record's own page — a server-side `redirect()` can only ever
 *   go to one hardcoded destination, so this form just returns the new
 *   id and lets the caller decide navigation client-side instead.
 */
export async function createInventory(input: InventoryFieldsInput): Promise<never>;
export async function createInventory(input: InventoryFieldsInput, options: { skipRedirect: true }): Promise<{ id: string }>;
export async function createInventory(input: InventoryFieldsInput, options?: { skipRedirect?: boolean }): Promise<{ id: string } | never> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) {
    throw new Error("在庫を登録する権限がありません（ADMIN または EDITOR のみ）。");
  }

  const name = input.name.trim();
  if (!name) throw new Error("商品名を入力してください。");

  const who = await getCurrentInventoryUserEmail();

  // Images resolved (uploads used as-is, "copy" slots copied to brand-new
  // S3 objects) *before* anything is written to Data — nothing exists
  // yet for this to leave half-created if it fails, and resolveImages
  // itself cleans up any copy it already made this call before
  // re-throwing. See that function's own comment for the ordering
  // rationale in full.
  const images = await resolveImages(input.images);

  // SKU is never user-entered (spec revision): a fresh, guaranteed-unique
  // value comes from the generateInventorySku Lambda's atomic DynamoDB
  // counter (see amplify/functions/generate-sku) — not "read the max SKU
  // and +1", which races under concurrent registrations. See that
  // function's own comment for why a plain conditional-write retry loop
  // isn't needed either: a native `ADD` is already race-free. This
  // applies identically whether this is a fresh registration or
  // confirming a duplicate — a duplicate never reuses the source's SKU.
  const { data: sku, errors: skuErrors } = await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
  if (skuErrors || !sku) {
    console.error("[createInventory] SKU generation failed:", skuErrors);
    await Promise.allSettled(allImageStorageKeys(images).map((k) => removeInventoryImage(k)));
    throw new Error(`SKUの発番に失敗しました: ${JSON.stringify(skuErrors)}`);
  }

  const { data: created, errors } = await serverDataClient.models.Inventory.create(
    {
      sku,
      name,
      categoryId: input.categoryId || undefined,
      statusId: input.statusId || undefined,
      locationId: input.locationId || undefined,
      quantity: input.quantity ?? 0,
      unit: input.unit?.trim() || undefined,
      purchasePrice: input.purchasePrice,
      salePrice: input.salePrice,
      note: input.note?.trim() || undefined,
      images,
      customFields: stringifyCustomFields(input.customFields),
      createdBy: who ?? undefined,
      updatedBy: who ?? undefined,
      // 第六ラウンドP0-5: 真のサーバー側cursor pagination用GSI
      // (amplify/data/resource.tsのInventoryモデルコメント参照)。
      // listingPartitionは常に固定値"ACTIVE"(在庫の削除は物理削除のみで
      // ソフトデリート経路が存在しないため、パーティションの出し入れ管理が
      // 不要 — 詳細はdocs/inventory-cursor-pagination-20260830.md)。
      listingPartition: "ACTIVE",
      listUpdatedAt: new Date().toISOString(),
      // Phase C fields — already fully parsed/typed by the caller (see
      // lib/inventory/extendedFields.ts's parseExtendedValues), so
      // spread straight through with no per-field handling needed here.
      ...extendedFieldsInput(input),
    },
    inventoryAuthMode,
  );

  if (errors || !created) {
    console.error("[createInventory] Inventory.create failed:", errors);
    // The SKU itself is not reclaimed — a gap in the sequence from an
    // aborted registration is harmless and exactly what an atomic
    // counter is expected to produce sometimes; see amplify/functions/
    // generate-sku's own comment on why it's never decremented.
    await Promise.allSettled(allImageStorageKeys(images).map((k) => removeInventoryImage(k)));
    throw new Error(`在庫の登録に失敗しました: ${JSON.stringify(errors)}`);
  }

  await logInventoryHistory(created.id, who, [{ fieldName: "登録", oldValue: null, newValue: `SKU ${sku} を新規登録` }]);

  // 件数の集計はプロセス内に60秒だけ持つ（lib/inventory/inventoryPage.ts）。
  // 追加・削除の直後に古い件数を出し続けないよう、ここで捨てる。
  clearInventoryCountCache();
  revalidatePath("/inventory");
  if (options?.skipRedirect) return { id: created.id };
  redirect(`/inventory/${created.id}`);
}

/**
 * Edit (spec: same fields as registration, minus SKU — never editable
 * here, it's the system-issued identifier). Diffs against the record's
 * current DB state (fetched here, not trusted from the client) to write
 * one InventoryHistory row per changed field, then removes whichever
 * previously-attached images are no longer in the submitted list —
 * computed the same safe way, against the server's own view of what was
 * actually on the record before this edit.
 */
export async function updateInventory(inventoryId: string, input: InventoryFieldsInput): Promise<never>;
export async function updateInventory(inventoryId: string, input: InventoryFieldsInput, options: { skipRedirect: true }): Promise<{ id: string }>;
export async function updateInventory(
  inventoryId: string,
  input: InventoryFieldsInput,
  options?: { skipRedirect?: boolean },
): Promise<{ id: string } | never> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) {
    throw new Error("在庫を編集する権限がありません（ADMIN または EDITOR のみ）。");
  }

  const name = input.name.trim();
  if (!name) throw new Error("商品名を入力してください。");

  const [existing, categories, locations, statuses] = await Promise.all([
    getInventoryDetail(inventoryId),
    listCategories(),
    listLocations(),
    listStatuses(),
  ]);
  if (!existing) throw new Error("対象の在庫が見つかりません。");

  const who = await getCurrentInventoryUserEmail();
  const images = await resolveImages(input.images);

  const { errors } = await serverDataClient.models.Inventory.update(
    {
      id: inventoryId,
      name,
      categoryId: input.categoryId || undefined,
      statusId: input.statusId || undefined,
      locationId: input.locationId || undefined,
      quantity: input.quantity ?? 0,
      unit: input.unit?.trim() || undefined,
      purchasePrice: input.purchasePrice,
      salePrice: input.salePrice,
      note: input.note?.trim() || undefined,
      images,
      customFields: stringifyCustomFields(input.customFields),
      updatedBy: who ?? undefined,
      // 第六ラウンドP0-5: ユーザーの実編集操作なので一覧の並び順を
      // 最新化してよい(thumbnailBackfill.tsの内部書き込みとは異なり、
      // ここは意図的にlistUpdatedAtを更新する対象)。
      listUpdatedAt: new Date().toISOString(),
      ...extendedFieldsInput(input),
    },
    inventoryAuthMode,
  );
  if (errors) {
    console.error("[updateInventory] Inventory.update failed:", errors);
    throw new Error(`在庫の更新に失敗しました: ${JSON.stringify(errors)}`);
  }

  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? id;
  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? id;
  const statusLabel = (id: string | null) => statuses.find((s) => s.id === id)?.label ?? id;

  // BELLO画像自動加工システム(2026-08-30指示書)§11.1/§11.2: カテゴリ
  // 「撮影待ち」→「出品待ち」遷移トリガーと、出品待ち中の画像追加差分
  // トリガー。Inventory.updateが成功した直後(このtry/catchで書き込み
  // 自体が失敗した場合はジョブも作られない、順序として正しい)、失敗
  // してもupdateInventory自体は失敗させない(画像加工ジョブの登録失敗
  // は在庫更新の成否と無関係——thumbnailKey生成失敗と同じ「必須では
  // ない」扱い)。
  try {
    const { triggerImageProcessingIfNeeded } = await import("@/lib/imageProcessing/jobService");
    await triggerImageProcessingIfNeeded({
      inventoryId,
      oldCategoryName: categoryName(existing.categoryId),
      newCategoryName: categoryName(input.categoryId ?? null),
      oldImageStorageKeys: existing.images.map((i) => i.storageKey),
      newImages: images.map((i) => ({ storageKey: i.storageKey, type: i.type, originalHash: i.originalHash })),
    });
  } catch (err) {
    console.error("[updateInventory] triggerImageProcessingIfNeeded failed (non-fatal):", err);
  }

  const oldImageKeys = existing.images.map((i) => i.storageKey);
  const newImageKeys = images.map((i) => i.storageKey);
  const imagesChanged = oldImageKeys.length !== newImageKeys.length || oldImageKeys.some((k, i) => k !== newImageKeys[i]);

  const changes = [
    diffField("商品名", existing.name, name),
    diffField("カテゴリ", categoryName(existing.categoryId), categoryName(input.categoryId ?? null)),
    diffField("保管場所", locationName(existing.locationId), locationName(input.locationId ?? null)),
    diffField("ステータス", statusLabel(existing.statusId), statusLabel(input.statusId ?? null)),
    diffField("数量", existing.quantity, input.quantity ?? 0),
    diffField("単位", existing.unit, input.unit),
    diffField("仕入単価", existing.purchasePrice, input.purchasePrice),
    diffField("販売価格", existing.salePrice, input.salePrice),
    diffField("備考", existing.note, input.note),
    diffField("追加項目", JSON.stringify(existing.customFields ?? {}), JSON.stringify(input.customFields ?? {})),
    imagesChanged ? { fieldName: "画像", oldValue: `${oldImageKeys.length}枚`, newValue: `${newImageKeys.length}枚` } : null,
    // Phase C: one diffField call per extended field, reusing the exact
    // same before/after normalization as every other field above — per
    // spec, this doesn't need to be more elaborate than "what changed",
    // and diffField already gives that for free per field rather than
    // needing a separate combined-summary code path.
    ...ALL_EXTENDED_FIELDS.map((field) => diffField(field.label, existing[field.key], input[field.key])),
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  await logInventoryHistory(inventoryId, who, changes);

  // Clean up S3 objects for images the edit actually removed — never
  // images the "copy"/"uploaded" resolution just created, and never
  // before the Inventory write above has already succeeded. Removes each
  // removed image's thumbnail too (Phase B), not just its original.
  const removedImages = existing.images.filter((i) => !newImageKeys.includes(i.storageKey));
  await Promise.allSettled(allImageStorageKeys(removedImages).map((k) => removeInventoryImage(k)));

  // 件数の集計はプロセス内に60秒だけ持つ（lib/inventory/inventoryPage.ts）。
  // 追加・削除の直後に古い件数を出し続けないよう、ここで捨てる。
  clearInventoryCountCache();
  revalidatePath("/inventory");
  revalidatePath(`/inventory/${inventoryId}`);
  if (options?.skipRedirect) return { id: inventoryId };
  redirect(`/inventory/${inventoryId}`);
}

/**
 * Hard delete (spec §3: soft-delete/restore is explicitly deferred to a
 * later phase — "現段階では完全削除でも構いません"). ADMIN-only,
 * enforced here for a clean error message and, independently, by the
 * schema itself (`Inventory`'s `.authorization()` in
 * amplify/data/resource.ts grants EDITOR only read/create/update — no
 * delete — so this can't be bypassed by skipping this check).
 *
 * InventoryHistory rows for this item are deliberately left in place —
 * an audit trail documenting what happened to a since-deleted item is
 * exactly what it's for; deleting them along with the item would erase
 * the one record of it ever having existed. The SKU counter
 * (amplify/functions/generate-sku) is never touched here either — spec
 * requires a deleted SKU stay retired, and the counter only ever moves
 * forward.
 */
export async function deleteInventory(inventoryId: string): Promise<never> {
  const role = await getInventoryRole();
  if (!canHardDeleteInventory(role)) {
    throw new Error("在庫を削除する権限がありません（ADMIN のみ）。");
  }

  const existing = await getInventoryDetail(inventoryId);
  if (!existing) throw new Error("対象の在庫が見つかりません。");

  const who = await getCurrentInventoryUserEmail();

  const { errors } = await serverDataClient.models.Inventory.delete({ id: inventoryId }, inventoryAuthMode);
  if (errors) {
    console.error("[deleteInventory] Inventory.delete failed:", errors);
    throw new Error(`在庫の削除に失敗しました: ${JSON.stringify(errors)}`);
  }

  await logInventoryHistory(inventoryId, who, [{ fieldName: "削除", oldValue: "有効", newValue: "削除済み" }]);
  await Promise.allSettled(allImageStorageKeys(existing.images).map((k) => removeInventoryImage(k)));

  // 件数の集計はプロセス内に60秒だけ持つ（lib/inventory/inventoryPage.ts）。
  // 追加・削除の直後に古い件数を出し続けないよう、ここで捨てる。
  clearInventoryCountCache();
  revalidatePath("/inventory");
  redirect("/inventory");
}
