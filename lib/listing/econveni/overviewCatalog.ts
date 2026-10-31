import "server-only";
import {
  BatchGetCommand,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  inventoryDdb,
  inventoryTable,
} from "@/lib/inventory/categoryPersistence";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { candidateConfig } from "@/lib/saleCandidates/store";
import type { SaleCandidate } from "@/lib/saleCandidates/model";
import type { ManualSyncData } from "./manualSyncModel";
import type { EconveniWorkflow } from "./workflowStore";
import type { EcCatalog, EcChannel } from "../ecManagement";
import type { ListingOverviewRow } from "../service";
type OverviewStock = {
  id: string;
  displayId?: string;
  name?: string;
  quantity?: number;
  plannedSalePrice?: number;
  categoryIds?: string[];
  categoryId?: string;
  market?: string;
  updatedAt?: string;
  createdAt?: string;
  deletedAt?: string;
  isDeleted?: boolean;
  listingPartition?: string;
};

/** Authenticated catalog caller only. Read explicitly linked stock in batches, never a full inventory scan. */
export async function remoteOverview(
  manual: ManualSyncData,
  workflows: EconveniWorkflow[],
): Promise<EcCatalog["econveni"]> {
  if (!manual.snapshot) return undefined;
  const owners = new Map<string, Set<string>>();
  const add = (productId: string, id: string) => {
    const ids = owners.get(productId) ?? new Set();
    ids.add(id);
    owners.set(productId, ids);
  };
  manual.links
    .filter((l) => !l.disabled)
    .forEach((l) => add(l.productId, l.inventoryId));
  workflows.forEach((w) => {
    if (w.save.productId) add(w.save.productId, w.inventoryId);
  });
  const ids = [
    ...new Set(
      manual.snapshot.products.flatMap((p) => [
        ...(owners.get(p.productId) ?? []),
      ]),
    ),
  ];
  const table = inventoryTable("Inventory"),
    stock = new Map<string, OverviewStock>();
  const categoriesPromise = listAllMasterEntries("Category");
  const stockPromise = Promise.all(
    Array.from({ length: Math.ceil(ids.length / 100) }, async (_, i) => {
      let keys = ids.slice(i * 100, (i + 1) * 100).map((id) => ({ id }));
      for (let attempt = 0; keys.length && attempt < 4; attempt++) {
        const r = await inventoryDdb.send(
          new BatchGetCommand({
            RequestItems: {
              [table]: {
                Keys: keys,
                ConsistentRead: true,
                ProjectionExpression:
                  "id,displayId,#n,quantity,plannedSalePrice,categoryId,categoryIds,market,updatedAt,createdAt,deletedAt,isDeleted,listingPartition",
                ExpressionAttributeNames: { "#n": "name" },
              },
            },
          }),
        );
        (r.Responses?.[table] ?? []).forEach((item) =>
          stock.set(String(item.id), item as OverviewStock),
        );
        keys = (r.UnprocessedKeys?.[table]?.Keys ?? []) as { id: string }[];
      }
      if (keys.length) throw Error("LINKED_STOCK_READ_INCOMPLETE");
    }),
  );
  const [categories] = await Promise.all([categoriesPromise, stockPromise]);
  const names = new Map(categories.map((c) => [c.id, c.name]));
  return {
    checkedAt: manual.snapshot.checkedAt,
    products: manual.snapshot.products.map((product) => {
      const targets = [...(owners.get(product.productId) ?? [])],
        id = targets.length === 1 ? targets[0] : null,
        item = id ? stock.get(id) : null;
      const live =
        item &&
        !item.deletedAt &&
        !item.isDeleted &&
        item.listingPartition !== "MERGED";
      const inventory: ListingOverviewRow | null = live
        ? {
            inventoryId: String(item.id),
            displayId: String(item.displayId ?? ""),
            name: String(item.name ?? ""),
            quantity: Number(item.quantity ?? 0),
            price:
              typeof item.plannedSalePrice === "number"
                ? item.plannedSalePrice
                : null,
            categories: (Array.isArray(item.categoryIds) &&
            item.categoryIds.length
              ? item.categoryIds
              : [item.categoryId]
            ).flatMap((v) => (v && names.has(v) ? [names.get(v)!] : [])),
            soldChannel:
              item.market === "ヤフオク"
                ? "YAHOO"
                : item.market === "メルカリSHOP"
                  ? "MERCARI_SHOPS"
                  : item.market === "ベイス"
                    ? "BASE"
                    : null,
            thumbnailKey: null,
            inventoryUpdatedAt: String(item.updatedAt ?? ""),
            inventoryCreatedAt: String(item.createdAt ?? ""),
            hasDraft: false,
            channelListing: null,
          }
        : null;
      return {
        product,
        inventoryId: id,
        inventory,
        ambiguous: targets.length > 1,
      };
    }),
  };
}

/** Only transaction linkage, no buyer, address, or message body leaves the server. */
export async function soldListingReferences(): Promise<
  NonNullable<EcCatalog["soldListings"]>
> {
  const refs: NonNullable<EcCatalog["soldListings"]> = {};
  let cursor: QueryCommandInput["ExclusiveStartKey"];
  do {
    const r = await inventoryDdb.send(
      new QueryCommand({
        TableName: candidateConfig().tableName,
        IndexName: "ByState",
        KeyConditionExpression: "#s=:done",
        ExpressionAttributeNames: {
          "#s": "state",
          "#r": "result",
          "#c": "channel",
        },
        ExpressionAttributeValues: { ":done": "DONE" },
        ProjectionExpression: "#r,#c,externalListingId,orderId,identifierType",
        ExclusiveStartKey: cursor,
        Limit: 1000,
      }),
    );
    for (const c of (r.Items ?? []) as SaleCandidate[]) {
      const channel: EcChannel | null =
        c.channel === "YAHOO"
          ? "YAHOO"
          : c.channel === "MERCARI"
            ? "MERCARI_SHOPS"
            : c.channel === "BASE"
              ? "BASE"
              : null;
      const id =
        c.externalListingId ||
        (c.identifierType === "AUCTION" ? c.orderId : null);
      if (!channel || !id || !c.result?.sourceId) continue;
      const target = (refs[c.result.sourceId] ??= {});
      (target[channel] ??= []).push(id);
    }
    cursor = r.LastEvaluatedKey;
  } while (cursor);
  return refs;
}
