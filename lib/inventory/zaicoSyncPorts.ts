import "server-only";
import type { Schema } from "@/amplify/data/resource";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { findOrCreateMasterEntryByName } from "./masters";
import { logInventoryHistory, type HistoryFieldChange } from "./history";
import { downloadAndImportInventoryImage, removeInventoryImage } from "./imageServerOps";
import type { InventoryImageRecord } from "./imageTypes";

/**
 * Ports-and-adapters boundary for the ZAICO sync engine (BELLO統合改修
 * master指示書 Phase A: ZAICO background sync). `lib/inventory/
 * zaicoSync.ts`'s actual mapping/dedup/diff/image-merge business logic
 * (syncOneZaicoItem and everything it calls internally that ISN'T an AWS
 * call) is completely unchanged from before this refactor - only the
 * "how do I actually reach DynamoDB/AppSync/S3" glue is behind this
 * interface now, instead of being hardcoded to serverDataClient inline.
 *
 * Original goal was two adapters - this Next.js one, and a Lambda-side
 * one using an IAM-authenticated Data client for a scheduled background
 * worker. The Lambda adapter was NOT shipped: it requires model-level
 * function-resource authorization (`allow.resource(fn)`), which does
 * not work in @aws-amplify/data-schema@1.26.1 (the latest published
 * version) - confirmed by both a compile error and a runtime
 * `TypeError: allow.resource is not a function`, and by the package's
 * own source comment ("TODO: delete when we make resource auth
 * available at each level in the schema"). See amplify/data/resource.ts's
 * ZaicoSyncJob comment for the full writeup.
 *
 * This interface is still valuable without that second adapter:
 * - It's the one thing to implement once Amplify Gen2 ships that
 *   feature, without touching zaicoSync.ts again.
 * - It makes the sync engine's dedup/diff/mapping logic unit-testable
 *   against an in-memory mock port, which was not possible before (the
 *   old code called the real serverDataClient directly, inline).
 *
 * `createServerSyncPort()` is a thin wrapper around the EXISTING,
 * unmodified serverDataClient/masters.ts/history.ts/imageServerOps.ts
 * functions - byte-identical behavior to before this refactor, used by
 * every Server Action call site (the synchronous 1件/5件/全件 sync paths,
 * and the new checkpointed background-batch path in
 * lib/inventory/zaicoBackgroundSync.ts).
 */

export type InventoryModel = Schema["Inventory"]["type"];

export interface NewInventoryInput {
  sku: string;
  name: string;
  categoryId?: string;
  locationId?: string;
  quantity: number;
  unit?: string;
  purchasePrice?: number;
  salePrice?: number;
  note?: string;
  barcode?: string;
  images: InventoryImageRecord[];
  customFields: string | undefined;
  createdBy: string;
  updatedBy: string;
  sourceSystem: string;
  sourceInventoryId: string;
  extendedFields: Record<string, unknown>;
}

export interface UpdateInventoryInput {
  id: string;
  name: string;
  categoryId?: string;
  locationId?: string;
  quantity?: number;
  unit?: string;
  note?: string;
  barcode?: string;
  purchasePrice?: number;
  salePrice?: number;
  images: InventoryImageRecord[];
  customFields: string | undefined;
  updatedBy: string;
  extendedFields: Record<string, unknown>;
}

export interface ZaicoSyncPort {
  findExistingBySourceId(sourceInventoryId: string): Promise<InventoryModel | null>;
  /** One full scan of every ZAICO-managed BELLO record, keyed by sourceInventoryId - called once per sync run (Next.js: once per request; Lambda: once per batch tick), never once per item. */
  fetchAllZaicoManaged(): Promise<Map<string, InventoryModel>>;
  findOrCreateCategory(name: string): Promise<{ id: string; created: boolean }>;
  findOrCreateLocation(name: string): Promise<{ id: string; created: boolean }>;
  generateSku(): Promise<string>;
  createInventory(input: NewInventoryInput): Promise<InventoryModel>;
  updateInventory(input: UpdateInventoryInput): Promise<void>;
  logHistory(inventoryId: string, who: string | null, changes: HistoryFieldChange[]): Promise<void>;
  /** BELLO統合改修 master指示書 Phase B: also returns the generated list-view thumbnail's key (null if generation failed — never fatal, see lib/inventory/thumbnail.ts). */
  downloadAndImportImage(url: string): Promise<{ storageKey: string; thumbnailKey: string | null }>;
  removeImage(path: string): Promise<void>;
}

/** Same scan semantics as lib/inventory/zaicoSync.ts's previous fetchAllZaicoManagedInventory - unchanged. */
async function serverFetchAllZaicoManaged(): Promise<Map<string, InventoryModel>> {
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

/**
 * The Next.js/cookie-based adapter - identical behavior to what
 * lib/inventory/zaicoSync.ts did inline before this refactor. Every
 * existing caller (the ADMIN-triggered 1件/5件/全件 sync Server Actions)
 * gets this by default, so their already-AWS-verified behavior is
 * unchanged.
 */
export function createServerSyncPort(): ZaicoSyncPort {
  return {
    async findExistingBySourceId(sourceInventoryId) {
      const { data } = await serverDataClient.models.Inventory.list({
        filter: { and: [{ sourceSystem: { eq: "ZAICO" } }, { sourceInventoryId: { eq: sourceInventoryId } }] },
        ...inventoryAuthMode,
      });
      return data.find((d) => !d.deletedAt) ?? null;
    },
    fetchAllZaicoManaged: serverFetchAllZaicoManaged,
    findOrCreateCategory: (name) => findOrCreateMasterEntryByName("Category", name),
    findOrCreateLocation: (name) => findOrCreateMasterEntryByName("Location", name),
    async generateSku() {
      const { data: sku, errors } = await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
      if (errors || !sku) throw new Error(`SKUの発番に失敗しました: ${JSON.stringify(errors)}`);
      return sku;
    },
    async createInventory(input) {
      const { data: created, errors } = await serverDataClient.models.Inventory.create(
        {
          sku: input.sku,
          name: input.name,
          categoryId: input.categoryId,
          locationId: input.locationId,
          quantity: input.quantity,
          unit: input.unit,
          purchasePrice: input.purchasePrice,
          salePrice: input.salePrice,
          note: input.note,
          barcode: input.barcode,
          images: input.images,
          customFields: input.customFields,
          createdBy: input.createdBy,
          updatedBy: input.updatedBy,
          sourceSystem: input.sourceSystem,
          sourceInventoryId: input.sourceInventoryId,
          ...input.extendedFields,
        },
        inventoryAuthMode,
      );
      if (errors || !created) throw new Error(`在庫の作成に失敗しました: ${JSON.stringify(errors)}`);
      return created;
    },
    async updateInventory(input) {
      const { errors } = await serverDataClient.models.Inventory.update(
        {
          id: input.id,
          name: input.name,
          categoryId: input.categoryId,
          locationId: input.locationId,
          quantity: input.quantity,
          unit: input.unit,
          note: input.note,
          barcode: input.barcode,
          purchasePrice: input.purchasePrice,
          salePrice: input.salePrice,
          images: input.images,
          customFields: input.customFields,
          updatedBy: input.updatedBy,
          ...input.extendedFields,
        },
        inventoryAuthMode,
      );
      if (errors) throw new Error(`在庫の更新に失敗しました: ${JSON.stringify(errors)}`);
    },
    logHistory: logInventoryHistory,
    downloadAndImportImage: downloadAndImportInventoryImage,
    removeImage: removeInventoryImage,
  };
}

/** Lazily constructed, reused across calls within the same Next.js request/process - matches how `serverDataClient` itself is already a module-level singleton. */
let cachedServerPort: ZaicoSyncPort | null = null;
export function getServerSyncPort(): ZaicoSyncPort {
  if (!cachedServerPort) cachedServerPort = createServerSyncPort();
  return cachedServerPort;
}
