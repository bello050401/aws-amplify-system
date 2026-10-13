import "server-only";

import type { MercariManualListingPack } from "@/app/actions/mercariManualListingPack";
import type { ListingDraftRecord, ListingImageRef } from "@/lib/listing/types";
import { B005396_INVENTORY_ID } from "./b005396GeneralPreparation.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import type { WebHttpDraftJob, WebHttpReviewEvidence } from "./webHttpDraftJob.ts";
import type { ObservedDraftAssetProof, ObservedDraftMappingProof,
  ObservedDraftMutation, ObservedDraftTargetProof } from
  "./webHttpObservedDraftWrite.ts";

type ImageRef = MercariManualListingPack["imageRefs"][number];
type Inventory = { id: string; sku: string; quantity: number;
  categoryName: string | null; market: string | null;
  saleEndDate: string | null };
type Duplicate = "ABSENT_COMPLETE" | "FOUND" | "AUTH_REQUIRED" |
  "UNKNOWN" | { status: "TARGET_ONLY_COMPLETE"; draftId: string };
export type ObservedDraftInputMapperPorts = {
  readInventory: (inventoryId: string) => Promise<Inventory | null>;
  readSavedDraft: (inventoryId: string) => Promise<ListingDraftRecord | null>;
  readSelectedCategory: (categoryId: string) => Promise<{
    categoryId: string; fullPath: string } | null>;
  hasExistingBinding: (job: WebHttpDraftJob) => Promise<boolean | null>;
  hasExistingChannelListing: (job: WebHttpDraftJob) => Promise<boolean | null>;
  /** The reader must exhaust all pages under the same shop/session. */
  readRemoteDuplicate: (job: WebHttpDraftJob,
    targetDraftId: string | null) => Promise<Duplicate>;
  readCurrentImageSha256: (ref: ImageRef) => Promise<string | null>;
};

/** These proofs have no production producer. They must come from independent verification. */
export type ObservedDraftSelectedProof = {
  status: "HUMAN_VERIFIED_SHOPS_SELECTION";
  shopId: string; snapshotFingerprint: string;
  categoryId: string; categoryPath: string;
  belloConditionCode: string;
  /** B005396's observed Shops enum for BELLO NO_NOTABLE_DAMAGE. */
  shopsConditionEnum: "CONDITION_CLEAN";
  adminPriceYen: number; adminQuantity: number;
  countryRestrictionTemplateId: string;
  channelListingScope: string;
  variantDefaultsVerified: true;
};
export type ObservedDraftImageProof = ObservedDraftAssetProof & {
  sourceImageSha256: string;
  sourceImageSha256s?: string[];
};
export type ObservedDraftSeedProof = {
  status: "VERIFIED_OBSERVED_SEED_STRATEGY";
  snapshotFingerprint: string; value: number;
};
export type ObservedDraftInputProofs = {
  selected: ObservedDraftSelectedProof;
  image: ObservedDraftImageProof;
  seed?: ObservedDraftSeedProof;
  targetDraft?: ObservedDraftTargetProof;
};
type BlockCode = "INVALID_JOB" | "CURRENT_SOURCE_UNVERIFIED" |
  "INELIGIBLE_OR_SOLD" | "DRAFT_CHANGED" | "SELECTION_UNVERIFIED" |
  "IMAGE_UNVERIFIED" | "EXISTING_PRODUCT_OR_READ_UNVERIFIED" |
  "TARGET_UNVERIFIED";
export type ObservedDraftInputMapResult = {
  ok: false; code: BlockCode; allowHttpWrite: false;
} | {
  ok: true; status: "MAPPED_NO_SEND"; allowHttpWrite: false;
  mutation: ObservedDraftMutation;
  assetProof: ObservedDraftAssetProof;
  mappingProof: ObservedDraftMappingProof;
};

const fail = (code: BlockCode): ObservedDraftInputMapResult =>
  ({ ok: false, code, allowHttpWrite: false });
const SHA256 = /^[0-9a-f]{64}$/;
const REMOTE_ID = /^[A-Za-z0-9]{1,64}$/;
const SOURCE_CODE = /^[A-Za-z0-9_-]{1,40}$/;
// Mirrors the EC exclusion names in ecEligibility.ts without loading its
// server data dependencies in this isolated mapping module.
const EXCLUDED_CATEGORIES = new Set(["補修待ち", "発送完了", "事務所備品",
  "コーディネート用", "無償提供", "破棄", "売り切れ"]);
const normalizeCategory = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const complete = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const normalizedRef = (ref: ListingImageRef | ImageRef) => ({
  source: ref.source ?? "INVENTORY", storageKey: ref.storageKey,
  sortOrder: ref.sortOrder, photoAssetId: ref.photoAssetId ?? null,
});

/** Build an inert mutation only after fresh BELLO reads and all proofs agree. */
export async function mapObservedDraftInput(job: WebHttpDraftJob,
  kind: "CREATE" | "UPDATE", ports: ObservedDraftInputMapperPorts,
  proofs: ObservedDraftInputProofs): Promise<ObservedDraftInputMapResult> {
  if (!initialWebHttpExecutionState(job) ||
      job.inventoryId.toLowerCase() === B005396_INVENTORY_ID ||
      kind !== "CREATE" && kind !== "UPDATE") return fail("INVALID_JOB");
  let snapshot: { pack: MercariManualListingPack;
    evidence: WebHttpReviewEvidence };
  try { snapshot = JSON.parse(job.snapshotJson); }
  catch { return fail("INVALID_JOB"); }
  const { pack, evidence } = snapshot;
  if (!pack || !evidence || !ports || !proofs ||
      !SOURCE_CODE.test(evidence.sourceInventoryCode) ||
      evidence.sourceInventoryCode.toUpperCase() === "B005396")
    return fail("INVALID_JOB");
  let inventory: Inventory | null;
  let draft: ListingDraftRecord | null;
  let category: { categoryId: string; fullPath: string } | null;
  let binding: boolean | null;
  let channel: boolean | null;
  try {
    [inventory, draft, category, binding, channel] = await Promise.all([
      ports.readInventory(job.inventoryId),
      ports.readSavedDraft(job.inventoryId),
      ports.readSelectedCategory(pack.categoryId),
      ports.hasExistingBinding(job),
      ports.hasExistingChannelListing(job),
    ]);
  } catch { return fail("CURRENT_SOURCE_UNVERIFIED"); }
  if (!inventory || typeof inventory.id !== "string" ||
      inventory.id.toLowerCase() !== job.inventoryId.toLowerCase() ||
      typeof inventory.sku !== "string" ||
      inventory.sku !== evidence.sourceInventoryCode ||
      inventory.sku.toUpperCase() === "B005396" ||
      job.managementCode !==
        `BELLO_${inventory.id.replace(/-/g, "").toUpperCase()}` ||
      !Number.isSafeInteger(inventory.quantity) ||
      inventory.market !== null && !complete(inventory.market))
    return fail("CURRENT_SOURCE_UNVERIFIED");
  if (!complete(inventory.categoryName) ||
      EXCLUDED_CATEGORIES.has(normalizeCategory(inventory.categoryName)) ||
      inventory.saleEndDate !== null ||
      inventory.market?.includes("メルカリ") ||
      inventory.quantity < 1 || inventory.quantity < pack.quantity)
    return fail("INELIGIBLE_OR_SOLD");
  if (!draft || draft.id !== pack.draftId ||
      typeof draft.inventoryId !== "string" ||
      draft.inventoryId.toLowerCase() !== job.inventoryId.toLowerCase() ||
      draft.updatedAt !== pack.draftUpdatedAt ||
      draft.title !== pack.title || draft.description !== pack.description ||
      draft.price !== evidence.sourcePriceYen ||
      draft.condition !== pack.condition ||
      draft.shippingMethod !== evidence.sourceShippingMethod ||
      !Array.isArray(draft.images) ||
      JSON.stringify(draft.images.map(normalizedRef)) !==
        JSON.stringify(pack.imageRefs.map(normalizedRef)) ||
      pack.imageRefs.length < 1 || pack.imageRefs.length > 20 ||
      evidence.imageCount !== pack.imageRefs.length || evidence.sourceQuantity < pack.quantity)
    return fail("DRAFT_CHANGED");
  if (!category || category.categoryId !== pack.categoryId ||
      category.fullPath !== pack.categoryPath ||
      evidence.selectedCategoryId !== pack.categoryId ||
      evidence.selectedCategoryPath !== pack.categoryPath ||
      evidence.selectedQuantity !== pack.quantity ||
      pack.brandId !== null || pack.brandName !== null ||
      pack.shipping.method !== "METHOD_TYPE_UNDECIDED" ||
      pack.shipping.payer !== "PAYER_TYPE_SELLER" ||
      pack.shipping.origin !== "jp11" ||
      pack.shipping.duration !== "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" ||
      !proofs.selected ||
      proofs.selected.status !== "HUMAN_VERIFIED_SHOPS_SELECTION" ||
      proofs.selected.shopId !== job.shopId ||
      proofs.selected.snapshotFingerprint !== job.snapshotFingerprint ||
      proofs.selected.categoryId !== pack.categoryId ||
      proofs.selected.categoryPath !== pack.categoryPath ||
      // B005396 BELLO displayed 目立った傷や汚れなし; its HAR update sent
      // CONDITION_CLEAN. No other BELLO-to-Shops condition pair is verified.
      pack.condition !== "NO_NOTABLE_DAMAGE" ||
      proofs.selected.belloConditionCode !== pack.condition ||
      proofs.selected.shopsConditionEnum !== "CONDITION_CLEAN" ||
      proofs.selected.adminPriceYen !== pack.priceYen ||
      proofs.selected.adminQuantity !== pack.quantity ||
      proofs.selected.variantDefaultsVerified !== true ||
      // The 2026-10-13 update sends an empty restriction ID for this shop.
      typeof proofs.selected.countryRestrictionTemplateId !== "string" ||
      !complete(proofs.selected.channelListingScope))
    return fail("SELECTION_UNVERIFIED");
  if (binding !== false || channel !== false)
    return fail("EXISTING_PRODUCT_OR_READ_UNVERIFIED");
  const image = proofs.image;
  if (!image || image.status !== "VERIFIED_SAME_IMAGE_BYTES" ||
      image.shopId !== job.shopId || image.inventoryId !== job.inventoryId ||
      image.snapshotFingerprint !== job.snapshotFingerprint ||
      image.imageRefCount !== pack.imageRefs.length ||
      typeof image.remoteAssetId !== "string" ||
      !REMOTE_ID.test(image.remoteAssetId) ||
      typeof image.sourceImageSha256 !== "string" ||
      !SHA256.test(image.sourceImageSha256)) return fail("IMAGE_UNVERIFIED");
  const assetIds = image.remoteAssetIds ?? [image.remoteAssetId];
  const imageHashes = image.sourceImageSha256s ?? [image.sourceImageSha256];
  if (assetIds.length !== pack.imageRefs.length || imageHashes.length !== assetIds.length ||
      new Set(assetIds).size !== assetIds.length || assetIds.some(id => !REMOTE_ID.test(id)) ||
      imageHashes.some(hash => !SHA256.test(hash)) || assetIds[0] !== image.remoteAssetId ||
      imageHashes[0] !== image.sourceImageSha256) return fail("IMAGE_UNVERIFIED");
  for (let index = 0; index < pack.imageRefs.length; index++) {
    try { if (await ports.readCurrentImageSha256(pack.imageRefs[index]) !== imageHashes[index])
      return fail("IMAGE_UNVERIFIED"); }
    catch { return fail("IMAGE_UNVERIFIED"); }
  }
  const target = kind === "UPDATE" ? proofs.targetDraft : undefined;
  if (kind === "UPDATE" && (!target ||
      target.status !== "VERIFIED_SAME_JOB_DRAFT" ||
      target.shopId !== job.shopId || target.inventoryId !== job.inventoryId ||
      target.snapshotFingerprint !== job.snapshotFingerprint ||
      typeof target.draftId !== "string" ||
      !REMOTE_ID.test(target.draftId))) return fail("TARGET_UNVERIFIED");
  let duplicate: Duplicate;
  try { duplicate = await ports.readRemoteDuplicate(job,
    target?.draftId ?? null); }
  catch { return fail("EXISTING_PRODUCT_OR_READ_UNVERIFIED"); }
  if (kind === "CREATE" && duplicate !== "ABSENT_COMPLETE" ||
      kind === "UPDATE" &&
        (typeof duplicate !== "object" ||
          duplicate.status !== "TARGET_ONLY_COMPLETE" ||
          duplicate.draftId !== target?.draftId))
    return fail("EXISTING_PRODUCT_OR_READ_UNVERIFIED");
  if (kind === "CREATE" && (!proofs.seed ||
      proofs.seed.status !== "VERIFIED_OBSERVED_SEED_STRATEGY" ||
      proofs.seed.snapshotFingerprint !== job.snapshotFingerprint ||
      !Number.isFinite(proofs.seed.value)))
    return fail("SELECTION_UNVERIFIED");
  const selected = proofs.selected;
  const variant = { name: "", quantity: pack.quantity,
    skuCode: job.managementCode, janCode: "",
    maxQuantityPerOrder: null };
  const common = { name: pack.title, description: pack.description,
    brandIds: null, shippingPayerType: pack.shipping.payer,
    countryRestrictionTemplateId: selected.countryRestrictionTemplateId,
    isRefurbished: false, channelListingScope: selected.channelListingScope };
  const mutation: ObservedDraftMutation = kind === "CREATE" ? {
    kind, idempotencyKeySeed: proofs.seed!.value,
    input: { ...common, shopId: job.shopId, price: null, assetIds: null,
      categoryIds: null, condition: null, shippingFromStateId: null,
      shippingDurationType: null, shippingMethodType: null,
      variants: [{ ...variant, catalogSkuId: null }] },
  } : {
    kind, targetDraftProof: target!,
    input: { ...common, id: target!.draftId, price: pack.priceYen,
      assetIds, categoryIds: [pack.categoryId],
      condition: selected.shopsConditionEnum,
      shippingFromStateId: pack.shipping.origin,
      shippingDurationType: pack.shipping.duration,
      shippingMethodType: pack.shipping.method,
      variants: [{ ...variant, catalogSkuId: "", attributes: [] }] },
  };
  const assetProof: ObservedDraftAssetProof = {
    status: "VERIFIED_SAME_IMAGE_BYTES", shopId: image.shopId,
    inventoryId: image.inventoryId,
    snapshotFingerprint: image.snapshotFingerprint,
    remoteAssetId: image.remoteAssetId, imageRefCount: assetIds.length,
    ...(assetIds.length > 1 ? { remoteAssetIds: assetIds } : {}),
  };
  return { ok: true, status: "MAPPED_NO_SEND", allowHttpWrite: false,
    mutation, assetProof,
    mappingProof: { status: "OBSERVED_INPUT_MAPPING_VERIFIED",
      snapshotFingerprint: job.snapshotFingerprint } };
}
