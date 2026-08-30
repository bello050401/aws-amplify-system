import { mapZaicoCoreFields, mapZaicoOptionalAttributes } from "./zaicoMapping";
import { normalizeImageRecord, type InventoryImageRecord } from "./imageTypes";
import { ALL_EXTENDED_FIELDS } from "./extendedFields";
import type { InventoryModel, ZaicoSyncPort, MasterCache } from "./zaicoSyncPorts";
import type { ZaicoInventory } from "@/lib/zaico/client";

/**
 * BELLO統合業務OS 第五ラウンド §4(P0-A): ZAICO同期エンジンの本体
 * (`syncOneZaicoItem`とその内部ヘルパー)を`lib/inventory/zaicoSync.ts`
 * から切り出した、意図的に**`server-only`を持たない**ファイル。
 *
 * 【切り出した理由】`zaicoSync.ts`はファイル冒頭で`import "server-only"`
 * しているため(`lib/zaico/client.ts`が必要——`syncSingleZaicoItem`/
 * `syncAllZaicoItems`がZAICO APIを直接呼ぶため)、そのファイルから
 * `syncOneZaicoItem`だけをLambda(`amplify/functions/zaico-sync-worker/`)
 * へbundleしようとしても、モジュール全体の評価時に`server-only`パッケー
 * ジが無条件でthrowし、Lambda cold start時にクラッシュする
 * (`server-only`はreact-server export conditionでのみ許可される
 * no-opへ解決される仕組みで、Next.jsのbundler以外——生Node実行環境や
 * esbuildによるLambda bundleを含む——では常に本物のthrowになる)。
 *
 * しかし`syncOneZaicoItem`自身のロジックは元々AWS/Next.js依存を一切
 * 持たない(全てのAWS操作は`port: ZaicoSyncPort`経由)——実際に
 * server-onlyを引きずり込んでいたのは、`zaicoSync.ts`が同じファイル内
 * で(`syncOneZaicoItem`とは無関係な)`getInventory`/`listInventories`
 * (`lib/zaico/client.ts`)を直接importしていたことと、
 * `diffField`/`stringifyCustomFields`/`parseCustomFields`/
 * `normalizeMasterName`という4つの**純粋関数**がserver-onlyな
 * ファイル(`history.ts`/`customFieldsCodec.ts`/`masters.ts`)に同居して
 * いたことだけが原因だった。
 *
 * 【対応方針、正直に】上記4つの純粋関数は「小さな重複を許容し、誤った
 * 依存結合を避ける」という、このリポジトリで既に確立された方針
 * (`lib/zaico/secretStore.ts` vs `lib/listing/mercari/secretStore.ts`、
 * `lib/imageProcessing/sharpProcessor.ts`のTHUMBNAIL_MAX_DIMENSION等)
 * をそのまま踏襲し、このファイル内へ複製する(元のロジックをコピー
 * するだけで、business logicの再実装ではない——値・分岐は一字一句
 * 同じ)。`mapZaicoCoreFields`/`mapZaicoOptionalAttributes`/
 * `normalizeImageRecord`/`ALL_EXTENDED_FIELDS`はどれも元から
 * server-onlyではないため、そのままimportして再利用する(複製しない)。
 *
 * `lib/inventory/zaicoSync.ts`はこのファイルの全exportをそのまま
 * re-exportし、既存のServer Action呼び出し元(app/actions/zaicoSync.ts
 * 等)への影響はゼロ(import pathも変更不要)。
 */

// ── history.tsから複製した純粋関数(diffField/normalize) ──────────────
export interface HistoryFieldChange {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}

function normalizeHistoryValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export function diffField(fieldName: string, oldValue: string | number | null | undefined, newValue: string | number | null | undefined): HistoryFieldChange | null {
  const oldNorm = normalizeHistoryValue(oldValue);
  const newNorm = normalizeHistoryValue(newValue);
  if (oldNorm === newNorm) return null;
  return { fieldName, oldValue: oldNorm, newValue: newNorm };
}

// ── customFieldsCodec.tsから複製した純粋関数 ──────────────────────────
export function stringifyCustomFields(fields: Record<string, unknown> | null | undefined): string | undefined {
  if (!fields || Object.keys(fields).length === 0) return undefined;
  return JSON.stringify(fields);
}

export function parseCustomFields(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      console.error("[Inventory.customFields] failed to JSON.parse stored value:", raw, err);
      return null;
    }
  }
  return raw as Record<string, unknown>;
}

// ── masters.tsから複製した純粋関数 ────────────────────────────────────
export function normalizeMasterName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

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

interface ImageMergeResult {
  images: InventoryImageRecord[];
  imported: boolean;
  newStorageKey?: string;
  newThumbnailKey?: string | null;
  oldStorageKeyToRemove?: string;
  oldThumbnailKeyToRemove?: string | null;
  warning?: string;
}

/** lib/inventory/zaicoSync.tsのmergeZaicoImageと同一(移動しただけ)。 */
async function mergeZaicoImage(existingImages: InventoryImageRecord[], newSourceUrl: string | null, port: ZaicoSyncPort): Promise<ImageMergeResult> {
  if (!newSourceUrl) {
    const hadZaicoImage = existingImages.some((i) => i.sourceSystem === "ZAICO");
    return {
      images: existingImages,
      imported: false,
      warning: hadZaicoImage
        ? "ZAICO側で画像URLが取得できませんでした(item_image消失の可能性)。BELLO側の既存画像は削除せずそのまま維持しています。"
        : undefined,
    };
  }

  const currentZaicoImage = existingImages.find((i) => i.sourceSystem === "ZAICO") ?? null;
  if (currentZaicoImage && currentZaicoImage.sourceUrl === newSourceUrl) {
    return { images: existingImages, imported: false };
  }

  let newKey: string;
  let newThumbnailKey: string | null;
  let newOriginalHash: string;
  try {
    ({ storageKey: newKey, thumbnailKey: newThumbnailKey, originalHash: newOriginalHash } = await port.downloadAndImportImage(newSourceUrl));
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
    thumbnailKey: newThumbnailKey,
    originalHash: newOriginalHash,
    classification: null,
  };
  const otherImages = existingImages.filter((i) => i !== currentZaicoImage);
  const otherNormal = otherImages.filter((i) => i.type === "NORMAL").map((i) => ({ ...i, isPrimary: false }));
  const damage = otherImages.filter((i) => i.type === "DAMAGE");
  const renumberedNormal = otherNormal.map((img, idx) => ({ ...img, sortOrder: idx + 1 }));

  return {
    images: [newRecord, ...renumberedNormal, ...damage],
    imported: true,
    newStorageKey: newKey,
    newThumbnailKey,
    oldStorageKeyToRemove: currentZaicoImage?.storageKey,
    oldThumbnailKeyToRemove: currentZaicoImage?.thumbnailKey,
  };
}

async function findOrCreateCategoryCached(name: string, port: ZaicoSyncPort, cache?: MasterCache): Promise<{ id: string; created: boolean }> {
  if (!cache) return port.findOrCreateCategory(name);
  const key = normalizeMasterName(name);
  const hit = cache.categories.get(key);
  if (hit) return { id: hit.id, created: false };
  const result = await port.findOrCreateCategory(name);
  cache.categories.set(key, { id: result.id });
  return result;
}

async function findOrCreateLocationCached(name: string, port: ZaicoSyncPort, cache?: MasterCache): Promise<{ id: string; created: boolean }> {
  if (!cache) return port.findOrCreateLocation(name);
  const key = normalizeMasterName(name);
  const hit = cache.locations.get(key);
  if (hit) return { id: hit.id, created: false };
  const result = await port.findOrCreateLocation(name);
  cache.locations.set(key, { id: result.id });
  return result;
}

/**
 * ZAICO 1件をBELLOへ同期する本体。lib/inventory/zaicoSync.tsの
 * (移動前の)同名関数と一字一句同じロジック——AWS/Next.js非依存、
 * `port`経由でのみ外界へアクセスする。Next.js側(Server Action)からも
 * Lambda(amplify/functions/zaico-sync-worker)からも、それぞれの
 * `ZaicoSyncPort`実装を渡して同じこの関数を呼ぶ(mapping/dedup/diff
 * ロジックの完全な単一化——§4「既存実装を作り直さない」)。
 */
export async function syncOneZaicoItem(
  zaicoItem: ZaicoInventory,
  who: string | null,
  prefetched: Map<string, InventoryModel> | undefined,
  port: ZaicoSyncPort,
  masterCache?: MasterCache,
): Promise<ZaicoSyncItemResult> {
  const sourceInventoryId = String(zaicoItem.id);
  const warnings: string[] = [];
  let categoryCreated = false;
  let locationCreated = false;

  try {
    const existing = prefetched ? (prefetched.get(sourceInventoryId) ?? null) : await port.findExistingBySourceId(sourceInventoryId);
    const isNewRecord = existing === null;

    const { fields: core, warnings: coreWarnings } = mapZaicoCoreFields(zaicoItem);
    warnings.push(...coreWarnings);

    const optAttrs = mapZaicoOptionalAttributes(zaicoItem.optional_attributes, isNewRecord);
    warnings.push(...optAttrs.warnings);
    warnings.push(...optAttrs.unmapped.map((u) => `unmapped optional attribute: "${u.name}"`));

    let categoryId = existing?.categoryId ?? null;
    if (core.categoryName) {
      try {
        const r = await findOrCreateCategoryCached(core.categoryName, port, masterCache);
        categoryId = r.id;
        categoryCreated = r.created;
      } catch (err) {
        warnings.push(`カテゴリの同期に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let locationId = existing?.locationId ?? null;
    if (core.locationName) {
      try {
        const r = await findOrCreateLocationCached(core.locationName, port, masterCache);
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
    const imageMerge = await mergeZaicoImage(existingImages, core.imageSourceUrl, port);
    if (imageMerge.warning) warnings.push(imageMerge.warning);

    const existingCustomFields = parseCustomFields(existing?.customFields ?? null) ?? {};
    const mergedCustomFields = { ...existingCustomFields, ...optAttrs.customFields };

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
      let sku: string;
      try {
        sku = await port.generateSku();
      } catch (err) {
        if (imageMerge.newStorageKey) await port.removeImage(imageMerge.newStorageKey);
        if (imageMerge.newThumbnailKey) await port.removeImage(imageMerge.newThumbnailKey);
        throw err;
      }

      let created: InventoryModel;
      try {
        created = await port.createInventory({
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
          extendedFields: optAttrs.extendedFields,
        });
      } catch (err) {
        if (imageMerge.newStorageKey) await port.removeImage(imageMerge.newStorageKey);
        if (imageMerge.newThumbnailKey) await port.removeImage(imageMerge.newThumbnailKey);
        throw err;
      }

      await port.logHistory(created.id, who, [
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

    const existingRecord = existing!;
    try {
      await port.updateInventory({
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
        extendedFields: optAttrs.extendedFields,
      });
    } catch (err) {
      if (imageMerge.newStorageKey) await port.removeImage(imageMerge.newStorageKey);
      if (imageMerge.newThumbnailKey) await port.removeImage(imageMerge.newThumbnailKey);
      throw err;
    }

    if (imageMerge.oldStorageKeyToRemove) await port.removeImage(imageMerge.oldStorageKeyToRemove);
    if (imageMerge.oldThumbnailKeyToRemove) await port.removeImage(imageMerge.oldThumbnailKeyToRemove);

    await port.logHistory(existingRecord.id, who, changes);

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
