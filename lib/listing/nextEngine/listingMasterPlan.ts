import { createHash } from "node:crypto";
import type { ListingDraftRecord, ChannelListingRecord } from "../types";
import { resolveEffectiveListingFields } from "../types";
import { prepareNextEngineProduct } from "./preparation";

type InventorySource = { id: string; sku: string; purchasePrice: number | null };

/** Build a frozen, read-only master payload for a saved BELLO listing. */
export function buildNextEngineListingMasterPlan(
  inventory: InventorySource,
  draft: ListingDraftRecord,
  listing: ChannelListingRecord | null,
  supplierCode: string,
) {
  if (inventory.id !== draft.inventoryId || (listing &&
      (inventory.id !== listing.inventoryId || draft.id !== listing.listingDraftId ||
       listing.channel !== "MERCARI_SHOPS"))) {
    throw new Error("出品下書きと在庫の対応を確認できません。");
  }
  if (listing && (listing.externalListingId || !["DRAFT", "READY"].includes(listing.status))) {
    throw new Error("既存の出品または処理中の出品があります。再送信しません。");
  }
  if (!inventory.sku || inventory.sku !== inventory.sku.trim() ||
      /^BELLO-NE-TEST-/.test(inventory.sku)) {
    throw new Error("在庫の商品コードを確認してください。");
  }
  if (draft.images.length === 0 || draft.images.length > 20) {
    throw new Error("出品画像を1〜20枚選択してください。");
  }
  if (!draft.condition) throw new Error("商品の状態を選択してください。");
  if (inventory.purchasePrice === null) throw new Error("原価を確定してください。");

  const effective = listing ? resolveEffectiveListingFields(draft, listing) : {
    title: draft.title, description: draft.description ?? "", price: draft.price ?? 0,
  };
  const prepared = prepareNextEngineProduct({
    sku: inventory.sku,
    supplierCode,
    title: effective.title,
    description: effective.description,
    price: effective.price,
    cost: inventory.purchasePrice,
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({
    inventoryId: inventory.id, draftId: draft.id, listingId: listing?.id ?? null,
    csv: prepared.csv, condition: draft.condition,
    images: draft.images.map(image => ({ key: image.storageKey, order: image.sortOrder })),
    mapping: listing?.categoryMapping ?? null,
  })).digest("hex");
  return { sku: inventory.sku, prepared, fingerprint, imageCount: draft.images.length };
}
