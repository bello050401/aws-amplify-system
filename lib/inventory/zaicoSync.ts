import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { Schema } from "@/amplify/data/resource";
import { getInventory, listInventories, type ZaicoInventory } from "@/lib/zaico/client";
import { mapZaicoCoreFields, mapZaicoOptionalAttributes } from "./zaicoMapping";
import { findOrCreateMasterEntryByName } from "./masters";
import { downloadAndImportInventoryImage, removeInventoryImage } from "./imageServerOps";
import { normalizeImageRecord, type InventoryImageRecord } from "./imageTypes";
import { diffField, logInventoryHistory, type HistoryFieldChange } from "./history";
import { stringifyCustomFields, parseCustomFields } from "./customFieldsCodec";
import { ALL_EXTENDED_FIELDS } from "./extendedFields";

type InventoryModel = Schema["Inventory"]["type"];

/**
 * The ZAICO→BELLO one-way sync engine (implementation instructions §1-39).
 * This file does NOT call ZAICO write endpoints (lib/zaico/client.ts has
 * none to call) and does NOT call the existing createInventory/
 * updateInventory Server Actions from app/actions/inventory.ts — those
 * `redirect()` on success, which is correct for a browser form submit
 * and wrong for a batch loop that needs to keep going across many items.
 * This talks to `serverDataClient.models.Inventory` directly instead,
 * reusing every other piece (generateInventorySku, logInventoryHistory,
 * diffField, the image S3 helpers, the master upsert helper) exactly as
 * the rest of the app does.
 *
 * ADMIN enforcement is NOT done here — it's the caller's job
 * (app/actions/zaicoSync.ts), matching how every other Inventory server
 * action in this codebase keeps the permission check at the Server
 * Action boundary, not buried in a shared lib function.
 */

export interface ZaicoSyncItemResult {
  zaicoId: string;
  name: string;
  status: "created" | "updated" | "unchanged" | "failed";
  inventoryId?: string;
  sku?: string;
  imageImported: boolean;
  categoryCreated: boolean;
  locationCreated: boolean;
  warnings: string[];
  error?: string;
}

export interface ZaicoSyncResult {
  startedAt: string;
  finishedAt: string;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  imageImported: number;
  categoryCreated: number;
  locationCreated: number;
  items: ZaicoSyncItemResult[];
}

/** A ZAICO-managed record already in BELLO, looked up by sourceInventoryId — a Scan+filter (no secondary index) is deliberate: at "a few hundred records" scale this is far simpler than adding an index or making one query per item, and syncAllZaicoItems below does exactly ONE such scan per run (via fetchAllZaicoManagedInventory), not one per item. */
async function findExistingZaicoInventory(sourceInventoryId: string): Promise<InventoryModel | null> {
  const { data } = await serverDataClient.models.Inventory.list({
    filter: { and: [{ sourceSystem: { eq: "ZAICO" } }, { sourceInventoryId: { eq: sourceInventoryId } }] },
    ...inventoryAuthMode,
  });
  return data.find((d) => !d.deletedAt) ?? null;
}

/** Every ZAICO-managed record, keyed by sourceInventoryId — fetched ONCE per full-catalog sync run (paginating through every AppSync page, never "fetch page 1 and assume that's everything") so syncOneZaicoItem never issues a per-item lookup query during a full sync. */
async function fetchAllZaicoManagedInventory(): Promise<Map<string, InventoryModel>> {
  const map = new Map<string, InventoryModel>();
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt } = await serverDataClient.models.Inventory.list({
      filter: { sourceSystem: { eq: "ZAICO" } },
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    for (const item of data) {
      if (item.deletedAt || !item.sourceInventoryId) continue;
      map.set(item.sourceInventoryId, item);
    }
    nextToken = nt;
  } while (nextToken);
  return map;
}

interface ImageMergeResult {
  images: InventoryImageRecord[];
  imported: boolean;
  /** A newly-uploaded image's key — the caller removes this on a failed create/update (it was never actually attached to a saved record). */
  newStorageKey?: string;
  /** The image slot this replaced, if any — the caller removes this only AFTER a successful create/update, never before (see updateInventory's identical ordering in app/actions/inventory.ts: never delete an S3 object the DB might still end up pointing at if the write fails). */
  oldStorageKeyToRemove?: string;
  warning?: string;
}

/**
 * Downloads+imports ZAICO's item_image.url only when it's actually new —
 * either there is no ZAICO image on this record yet, or the URL changed
 * since the image currently tagged sourceSystem:"ZAICO" was imported
 * (spec §16: unchanged URL ⇒ no re-download/re-upload). The new image
 * always becomes the top image (NORMAL, isPrimary, sortOrder 0 — spec
 * §17), and every BELLO-added NORMAL/DAMAGE photo is left completely
 * alone (spec: 同期でBELLO追加画像を削除しない) — only ever the ONE
 * slot tagged as ZAICO's own is ever replaced.
 */
async function mergeZaicoImage(existingImages: InventoryImageRecord[], newSourceUrl: string | null): Promise<ImageMergeResult> {
  if (!newSourceUrl) return { images: existingImages, imported: false };

  const currentZaicoImage = existingImages.find((i) => i.sourceSystem === "ZAICO") ?? null;
  if (currentZaicoImage && currentZaicoImage.sourceUrl === newSourceUrl) {
    return { images: existingImages, imported: false };
  }

  let newKey: string;
  try {
    newKey = await downloadAndImportInventoryImage(newSourceUrl);
  } catch (err) {
    return { images: existingImages, imported: false, warning: err instanceof Error ? err.message : "ZAICO画像の取り込みに失敗しました。" };
  }

  const newRecord: InventoryImageRecord = {
    storageKey: newKey,
    sortOrder: 0,
    type: "NORMAL",
    isPrimary: true,
    sourceSystem: "ZAICO",
    sourceUrl: newSourceUrl,
  };
  const otherImages = existingImages.filter((i) => i !== currentZaicoImage);
  const otherNormal = otherImages.filter((i) => i.type === "NORMAL").map((i) => ({ ...i, isPrimary: false }));
  const damage = otherImages.filter((i) => i.type === "DAMAGE");
  const renumberedNormal = otherNormal.map((img, idx) => ({ ...img, sortOrder: idx + 1 }));

  return {
    images: [newRecord, ...renumberedNormal, ...damage],
    imported: true,
    newStorageKey: newKey,
    oldStorageKeyToRemove: currentZaicoImage?.storageKey,
  };
}

/**
 * Syncs exactly one ZAICO item into BELLO — create if no BELLO record
 * carries this sourceInventoryId yet, update (ZAICO-authoritative fields
 * always overwritten) otherwise, or "unchanged" if nothing about it
 * actually differs. Never throws — every failure path is caught and
 * returned as `status: "failed"` with a human-readable `error`, so one
 * bad item can never take down a whole batch (spec: 部分的な失敗が全体
 * を止めないこと).
 *
 * `prefetched`, when given (full-catalog sync), skips the per-item
 * findExistingZaicoInventory lookup in favor of the one upfront scan.
 */
export async function syncOneZaicoItem(zaicoItem: ZaicoInventory, who: string | null, prefetched?: Map<string, InventoryModel>): Promise<ZaicoSyncItemResult> {
  const sourceInventoryId = String(zaicoItem.id);
  const warnings: string[] = [];
  let categoryCreated = false;
  let locationCreated = false;

  try {
    const existing = prefetched ? (prefetched.get(sourceInventoryId) ?? null) : await findExistingZaicoInventory(sourceInventoryId);
    const isNewRecord = existing === null;

    const { fields: core, warnings: coreWarnings } = mapZaicoCoreFields(zaicoItem);
    warnings.push(...coreWarnings);

    const optAttrs = mapZaicoOptionalAttributes(zaicoItem.optional_attributes, isNewRecord);
    warnings.push(...optAttrs.warnings);
    warnings.push(...optAttrs.unmapped.map((u) => `unmapped optional attribute: "${u.name}"`));

    // Category / Location: ZAICO is authoritative for a ZAICO-managed
    // item on every sync (spec §8/§9) — even if BELLO staff manually
    // changed it since the last sync, the next sync moves it back.
    let categoryId = existing?.categoryId ?? null;
    if (core.categoryName) {
      try {
        const r = await findOrCreateMasterEntryByName("Category", core.categoryName);
        categoryId = r.id;
        categoryCreated = r.created;
      } catch (err) {
        warnings.push(`カテゴリの同期に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let locationId = existing?.locationId ?? null;
    if (core.locationName) {
      try {
        const r = await findOrCreateMasterEntryByName("Location", core.locationName);
        locationId = r.id;
        locationCreated = r.created;
      } catch (err) {
        warnings.push(`保管場所の同期に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      warnings.push("ZAICO側で保管場所(place)が取得できませんでした。保管場所は更新していません。");
    }

    const existingImages: InventoryImageRecord[] = (existing?.images ?? [])
      .filter((img): img is NonNullable<typeof img> => Boolean(img))
      .map(normalizeImageRecord);
    const imageMerge = await mergeZaicoImage(existingImages, core.imageSourceUrl);
    if (imageMerge.warning) warnings.push(imageMerge.warning);

    const existingCustomFields = parseCustomFields(existing?.customFields ?? null) ?? {};
    const mergedCustomFields = { ...existingCustomFields, ...optAttrs.customFields };

    // ── Diff against the existing record (skipped for a brand-new one —
    // everything about it is "new" by definition). Only the fields ZAICO
    // actually returned a usable value for this sync are diffed/written
    // — a field ZAICO didn't send a value for this time (null/absent)
    // leaves BELLO's existing value untouched rather than being zeroed
    // out, which is the conservative reading of "ZAICO由来フィールドは
    // 上書き" that avoids silently destroying data on a sparse response.
    const changes: HistoryFieldChange[] = [];
    if (!isNewRecord && existing) {
      const push = (c: HistoryFieldChange | null) => c && changes.push(c);
      push(diffField("商品名", existing.name, core.name));
      if (core.quantity !== null) push(diffField("数量", existing.quantity, core.quantity));
      if (core.unit !== null) push(diffField("単位", existing.unit, core.unit));
      if (core.note !== null) push(diffField("備考", existing.note, core.note));
      if (core.barcode !== null) push(diffField("QRコード・バーコード", existing.barcode, core.barcode));
      if (core.categoryName && categoryId !== (existing.categoryId ?? null)) {
        changes.push({ fieldName: "カテゴリ", oldValue: null, newValue: `${core.categoryName}（ZAICO同期）` });
      }
      if (core.locationName && locationId !== (existing.locationId ?? null)) {
        changes.push({ fieldName: "保管場所", oldValue: null, newValue: `${core.locationName}（ZAICO同期）` });
      }
      if (optAttrs.coreFields.purchasePrice !== undefined) push(diffField("購入価格", existing.purchasePrice, optAttrs.coreFields.purchasePrice));
      if (optAttrs.coreFields.salePrice !== undefined) push(diffField("販売価格", existing.salePrice, optAttrs.coreFields.salePrice));
      for (const [key, value] of Object.entries(optAttrs.extendedFields)) {
        const label = ALL_EXTENDED_FIELDS.find((f) => f.key === key)?.label ?? key;
        const oldValue = (existing as unknown as Record<string, unknown>)[key] as string | number | null | undefined;
        push(diffField(label, oldValue ?? null, value));
      }
      for (const [key, value] of Object.entries(optAttrs.customFields)) {
        push(diffField(key, (existingCustomFields[key] as string | number | null | undefined) ?? null, value));
      }
      if (imageMerge.imported) changes.push({ fieldName: "ZAICO画像", oldValue: null, newValue: "更新" });
    }

    if (!isNewRecord && existing && changes.length === 0) {
      // Nothing to write — the one thing that COULD have needed cleanup
      // (a downloaded-but-unused image) never happens here: mergeZaicoImage
      // only downloads when it detected an actual URL change, which
      // always produces a "ZAICO画像" change above.
      return {
        zaicoId: sourceInventoryId,
        name: core.name,
        status: "unchanged",
        inventoryId: existing.id,
        sku: existing.sku,
        imageImported: false,
        categoryCreated,
        locationCreated,
        warnings,
      };
    }

    if (isNewRecord) {
      const { data: sku, errors: skuErrors } = await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
      if (skuErrors || !sku) {
        if (imageMerge.newStorageKey) await removeInventoryImage(imageMerge.newStorageKey);
        throw new Error(`SKUの発番に失敗しました: ${JSON.stringify(skuErrors)}`);
      }

      const { data: created, errors } = await serverDataClient.models.Inventory.create(
        {
          sku,
          name: core.name,
          categoryId: categoryId ?? undefined,
          locationId: locationId ?? undefined,
          quantity: core.quantity ?? 0,
          unit: core.unit ?? undefined,
          purchasePrice: optAttrs.coreFields.purchasePrice,
          salePrice: optAttrs.coreFields.salePrice,
          note: core.note ?? undefined,
          barcode: core.barcode ?? undefined,
          images: imageMerge.images,
          customFields: stringifyCustomFields(mergedCustomFields),
          createdBy: who ?? "ZAICO同期",
          updatedBy: who ?? "ZAICO同期",
          sourceSystem: "ZAICO",
          sourceInventoryId,
          ...optAttrs.extendedFields,
        },
        inventoryAuthMode,
      );
      if (errors || !created) {
        if (imageMerge.newStorageKey) await removeInventoryImage(imageMerge.newStorageKey);
        throw new Error(`在庫の作成に失敗しました: ${JSON.stringify(errors)}`);
      }

      await logInventoryHistory(created.id, who, [
        { fieldName: "ZAICO同期", oldValue: null, newValue: `ZAICO ID ${sourceInventoryId} から新規作成 (SKU ${sku})` },
      ]);

      return {
        zaicoId: sourceInventoryId,
        name: core.name,
        status: "created",
        inventoryId: created.id,
        sku,
        imageImported: imageMerge.imported,
        categoryCreated,
        locationCreated,
        warnings,
      };
    }

    // existing !== null here (isNewRecord is false) — TypeScript can't
    // narrow that across the branches above, so assert it explicitly
    // rather than repeating the `existing &&` guard a third time.
    const existingRecord = existing!;
    const { errors } = await serverDataClient.models.Inventory.update(
      {
        id: existingRecord.id,
        name: core.name,
        categoryId: categoryId ?? undefined,
        locationId: locationId ?? undefined,
        quantity: core.quantity !== null ? core.quantity : undefined,
        unit: core.unit !== null ? core.unit : undefined,
        note: core.note !== null ? core.note : undefined,
        barcode: core.barcode !== null ? core.barcode : undefined,
        purchasePrice: optAttrs.coreFields.purchasePrice,
        salePrice: optAttrs.coreFields.salePrice,
        images: imageMerge.images,
        customFields: stringifyCustomFields(mergedCustomFields),
        updatedBy: who ?? "ZAICO同期",
        ...optAttrs.extendedFields,
      },
      inventoryAuthMode,
    );
    if (errors) {
      if (imageMerge.newStorageKey) await removeInventoryImage(imageMerge.newStorageKey);
      throw new Error(`在庫の更新に失敗しました: ${JSON.stringify(errors)}`);
    }

    // Only now — after the write that (re)points the record at it has
    // actually succeeded — is the old ZAICO image slot's S3 object
    // removed. Best-effort: a failure here is logged inside
    // removeInventoryImage itself and never re-thrown.
    if (imageMerge.oldStorageKeyToRemove) await removeInventoryImage(imageMerge.oldStorageKeyToRemove);

    await logInventoryHistory(existingRecord.id, who, changes);

    return {
      zaicoId: sourceInventoryId,
      name: core.name,
      status: "updated",
      inventoryId: existingRecord.id,
      sku: existingRecord.sku,
      imageImported: imageMerge.imported,
      categoryCreated,
      locationCreated,
      warnings,
    };
  } catch (err) {
    return {
      zaicoId: sourceInventoryId,
      name: zaicoItem.title?.trim() || sourceInventoryId,
      status: "failed",
      imageImported: false,
      categoryCreated,
      locationCreated,
      warnings,
      error: err instanceof Error ? err.message : "不明なエラー",
    };
  }
}

function aggregateResult(startedAt: string, items: ZaicoSyncItemResult[]): ZaicoSyncResult {
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    total: items.length,
    created: items.filter((i) => i.status === "created").length,
    updated: items.filter((i) => i.status === "updated").length,
    unchanged: items.filter((i) => i.status === "unchanged").length,
    failed: items.filter((i) => i.status === "failed").length,
    imageImported: items.filter((i) => i.imageImported).length,
    categoryCreated: items.filter((i) => i.categoryCreated).length,
    locationCreated: items.filter((i) => i.locationCreated).length,
    items,
  };
}

/** The Phase 1 test path (spec §30-36): sync exactly one ZAICO item by its numeric id, and only that one. */
export async function syncSingleZaicoItem(zaicoId: string, who: string | null): Promise<ZaicoSyncResult> {
  const startedAt = new Date().toISOString();
  const zaicoItem = await getInventory(zaicoId);
  const result = await syncOneZaicoItem(zaicoItem, who);
  return aggregateResult(startedAt, [result]);
}

/**
 * Full-catalog sync (spec §11, only to be reached once the single-item
 * path is verified). One upfront prefetch of every ZAICO-managed BELLO
 * record (fetchAllZaicoManagedInventory) plus ZAICO's own paginated
 * listing (lib/zaico/client.ts's listInventories, throttled/retried
 * internally) — a single blocking Server Action call, deliberately not a
 * Lambda/background-job architecture: this app isn't hosted online yet
 * (local dev / local sandbox only), so there's no practical serverless
 * request-timeout risk today, and building queue/background-job
 * infrastructure ahead of that need would be over-engineering for "a few
 * hundred records" (spec's own instruction: 過剰設計しないこと). Revisit
 * this once the app is actually deployed behind a request-timeout-bound
 * host.
 */
export async function syncAllZaicoItems(who: string | null): Promise<ZaicoSyncResult> {
  const startedAt = new Date().toISOString();
  const prefetched = await fetchAllZaicoManagedInventory();
  const items: ZaicoSyncItemResult[] = [];
  let page = 1;
  // ZAICO API pagination convention (page/per_page, "fewer than
  // requested ⇒ last page") is a best-effort assumption — see
  // lib/zaico/client.ts's listInventories comment; not re-confirmed
  // against a real multi-page response in this environment.
  for (;;) {
    const { items: zaicoItems, hasMore } = await listInventories(page);
    for (const zaicoItem of zaicoItems) {
      items.push(await syncOneZaicoItem(zaicoItem, who, prefetched));
    }
    if (!hasMore) break;
    page += 1;
  }
  return aggregateResult(startedAt, items);
}
