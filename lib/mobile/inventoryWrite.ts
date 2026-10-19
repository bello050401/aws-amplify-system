import {splitCategoryNames} from '@/lib/inventory/categories';
import { createHash } from "node:crypto";
import type { InventoryFieldsInput } from "@/app/actions/inventory";
import type { InventoryDetail, MasterOption, StatusOption } from "@/lib/inventory/queries";
import { ALL_EXTENDED_FIELDS } from "@/lib/inventory/extendedFields";
import { assertInventoryVersion } from "@/lib/inventory/conditionalUpdate";
import { DETAIL_FIELDS } from "@/mobile/src/domain/detailFields";
import { validateDraft, type InventoryDraft } from "@/mobile/src/domain/inventory";
import type { SaveRequest } from "@/mobile/src/domain/editor";
import type { MobileFeatures } from "./accessPolicy";
import type { WebPhotoAssetView } from "../photoRegistration/webAdapter";
import { extensionForMimeType, photoAssetS3Key } from "../photoRegistration/types";
import { resolveProductGallerySource } from "../photoRegistration/gallerySelection";
import { imageId } from "./inventoryPhotos";

// Internal save receipt, stored in the same atomic Inventory update as the fields.
// It contains no credentials or product text and is excluded from mobile projection.
export const MOBILE_WRITE_RECEIPT = "__belloMobileWrite";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const draftKeys = ["name", "quantity", "unit", "location", "category", "condition", "statusId", "note", "barcode", "plannedSalePrice"] as const;
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === "object" && !Array.isArray(raw);
export class MobileWriteValidationError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "FIELD_FORBIDDEN") { super(code); }
}
const invalid = (): never => { throw new MobileWriteValidationError("INVALID_INPUT"); };

/** Accept only editor fields, uploads and IDs of photos belonging to this inventory. */
export function parseMobileSave(raw: unknown, id: string): SaveRequest {
  if (!object(raw) || !uuid.test(id) || raw.id !== id || typeof raw.mutationId !== "string" || !uuid.test(raw.mutationId) ||
      typeof raw.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(raw.expectedUpdatedAt)) ||
      Object.keys(raw).some(key => !["id", "mutationId", "expectedUpdatedAt", "draft", "create", "uploads", "copyFrom", "removedPhotoIds"].includes(key))) return invalid();
  if (raw.removedPhotoIds !== undefined && (raw.create || !Array.isArray(raw.removedPhotoIds) || raw.removedPhotoIds.length > 100 ||
      raw.removedPhotoIds.some(id => typeof id !== "string" || !/^inventory-[a-f0-9]{24}$/.test(id)) ||
      new Set(raw.removedPhotoIds).size !== raw.removedPhotoIds.length)) return invalid();
  if (raw.create !== undefined && raw.create !== true) return invalid();
  if (raw.copyFrom !== undefined && (!raw.create || !object(raw.copyFrom) || Object.keys(raw.copyFrom).some(key => !["id", "updatedAt"].includes(key)) ||
      typeof raw.copyFrom.id !== "string" || !uuid.test(raw.copyFrom.id) || raw.copyFrom.id === id ||
      typeof raw.copyFrom.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.copyFrom.updatedAt)))) return invalid();
  if (raw.uploads !== undefined && (!Array.isArray(raw.uploads) || raw.uploads.length > 100 || raw.uploads.some(photo =>
    !object(photo) || Object.keys(photo).some(key => !["storageKey", "type"].includes(key)) ||
    typeof photo.storageKey !== "string" || !/^inventory\/mobile\/[a-z0-9-]+\/[a-f0-9-]{36}\/[a-f0-9]{64}\.jpg$/.test(photo.storageKey) ||
    !["NORMAL", "DAMAGE"].includes(String(photo.type))))) return invalid();
  const draft = raw.draft;
  if (!object(draft) || !object(draft.details) || Object.keys(draft).some(key => key !== "details" && !draftKeys.includes(key as typeof draftKeys[number])) ||
      draftKeys.some(key => typeof draft[key] !== "string" || (draft[key] as string).length > 16000)) return invalid();
  for (const [key, value] of Object.entries(draft.details)) {
    if (!DETAIL_FIELDS.some(field => field.key === key) || typeof value !== "string" || value.length > 16000) return invalid();
  }
  if (validateDraft(draft as InventoryDraft)) return invalid();
  // GraphQL Int, not JavaScript's wider safe integer range.
  if (Number(draft.quantity) > 2147483647 || Number(draft.details.purchaseQuantity ?? 0) > 2147483647) return invalid();
  return { id, mutationId: raw.mutationId, expectedUpdatedAt: raw.expectedUpdatedAt, draft: draft as InventoryDraft, ...(raw.create ? { create: true } : {}), ...(raw.uploads ? { uploads: raw.uploads as SaveRequest["uploads"] } : {}), ...(raw.copyFrom ? { copyFrom: raw.copyFrom as SaveRequest["copyFrom"] } : {}), ...(raw.removedPhotoIds ? { removedPhotoIds: raw.removedPhotoIds as string[] } : {}) };
}

function receiptFor(request: SaveRequest, owner: string) {
  const draft = request.draft;
  const values = [...draftKeys.map(key => [key, draft[key]]), ["details", Object.entries(draft.details).sort(([a], [b]) => a.localeCompare(b))]];
  return { owner, mutationId: request.mutationId, fingerprint: createHash("sha256").update(JSON.stringify([request.id, request.expectedUpdatedAt, values, ...(request.create || request.uploads ? [request.create ?? false, request.uploads ?? []] : []), ...(request.copyFrom ? [request.copyFrom] : []), ...(request.removedPhotoIds?.length ? [[...request.removedPhotoIds].sort()] : [])])).digest("hex") };
}

export function mobileWriteWasApplied(row: InventoryDetail, request: SaveRequest, owner: string): boolean {
  const saved = row.customFields?.[MOBILE_WRITE_RECEIPT];
  const expected = receiptFor(request, owner);
  return object(saved) && saved.owner === expected.owner && saved.mutationId === expected.mutationId && saved.fingerprint === expected.fingerprint;
}

function masterId(name: string, current: string | null, choices: MasterOption[]): string {
  if (!name.trim()) return "";
  if (choices.some(option => option.id === current && option.name === name)) return current!;
  const matches = choices.filter(option => option.name === name);
  if (matches.length !== 1) return invalid();
  return matches[0].id;
}

/** Merge only allowed fields into BELLO's current record, keeping every unexposed value and image. */
export function mobileInventoryInput(row: InventoryDetail, request: SaveRequest, owner: string, features: MobileFeatures,
  categories: MasterOption[], locations: MasterOption[], statuses: StatusOption[]): InventoryFieldsInput {
  assertInventoryVersion(request.expectedUpdatedAt, row.updatedAt);
  const removed = new Set(request.removedPhotoIds ?? []);
  // Resolve opaque IDs against the current product; never accept client-supplied storage paths.
  if ([...removed].some(id => !row.images.some(image => imageId(image.storageKey) === id))) return invalid();
  const { draft } = request;
  if (draft.statusId && draft.statusId !== row.statusId && !statuses.some(status => status.id === draft.statusId)) return invalid();
  const input: InventoryFieldsInput = {
    name: draft.name, quantity: Number(draft.quantity), unit: draft.unit, note: draft.note,
    categoryIds: splitCategoryNames(draft.category).map(name=>masterId(name, row.categoryId, categories)),
    categoryId: splitCategoryNames(draft.category).map(name=>masterId(name, row.categoryId, categories))[0] ?? "", locationId: masterId(draft.location, row.locationId, locations), statusId: draft.statusId,
    expectedUpdatedAt: request.expectedUpdatedAt, purchasePrice: row.purchasePrice, salePrice: row.salePrice,
    images: row.images.filter(image => !removed.has(imageId(image.storageKey))).map(image => ({ ...image, kind: "uploaded" as const })),
    customFields: { ...row.customFields },
  };
  const columns = input as unknown as Record<string, unknown>;
  for (const field of ALL_EXTENDED_FIELDS) columns[field.key] = row[field.key];
  input.barcode = draft.barcode || null;
  input.plannedSalePrice = draft.plannedSalePrice === "" ? null : Number(draft.plannedSalePrice);
  for (const field of DETAIL_FIELDS) {
    if (!Object.hasOwn(draft.details, field.key)) continue;
    if (field.feature && !features[field.feature]) throw new MobileWriteValidationError("FIELD_FORBIDDEN");
    if (field.readOnly) {
      if (draft.details[field.key] !== String(row[field.key as keyof InventoryDetail] ?? "")) throw new MobileWriteValidationError("FIELD_FORBIDDEN");
      continue;
    }
    const text = draft.details[field.key].trim();
    const value = !text ? null : field.kind === "money" || field.kind === "integer" ? Number(text) : field.kind === "date" ? text.replaceAll("/", "-") : text;
    if (field.custom) input.customFields![field.key] = value;
    else columns[field.key] = value;
  }
  const seen = new Set(input.images.map(image => image.kind === "uploaded" ? image.storageKey : ""));
  for (const photo of request.uploads ?? []) {
    if (!photo.storageKey.startsWith('inventory/mobile/' + owner + '/')) throw new MobileWriteValidationError("FIELD_FORBIDDEN");
    if (seen.has(photo.storageKey)) continue;
    seen.add(photo.storageKey);
    input.images.push({kind: "uploaded", storageKey: photo.storageKey, type: photo.type, sortOrder: input.images.length,
      isPrimary: photo.type === "NORMAL" && !input.images.some(image => image.type === "NORMAL"),
      sourceSystem: null, sourceUrl: null, thumbnailKey: null, mediumKey: null, originalHash: null, classification: null});
  }
  input.customFields![MOBILE_WRITE_RECEIPT] = receiptFor(request, owner);
  return input;
}

/** A fresh BELLO record uses the same field mapping and master validation as an edit. */
export function mobileCreateInput(request: SaveRequest, owner: string, features: MobileFeatures,
  categories: MasterOption[], locations: MasterOption[], statuses: StatusOption[]): InventoryFieldsInput {
  const blank = Object.fromEntries(ALL_EXTENDED_FIELDS.map(field => [field.key, null]));
  const row = { ...blank, id: request.id, updatedAt: request.expectedUpdatedAt, categoryId: null, locationId: null,
    statusId: null, images: [], customFields: {}, purchasePrice: null, salePrice: null } as unknown as InventoryDetail;
  return mobileInventoryInput(row, request, owner, features, categories, locations, statuses);
}

/** Copy only product values and independently owned photos; never source IDs, sync links, receipts or audit metadata. */
export function mobileCopyInput(source: InventoryDetail, assets: WebPhotoAssetView[], bucket: string | undefined,
  request: SaveRequest, owner: string, features: MobileFeatures, categories: MasterOption[], locations: MasterOption[], statuses: StatusOption[]): InventoryFieldsInput {
  if (!request.create || request.copyFrom?.id !== source.id) return invalid();
  assertInventoryVersion(request.copyFrom.updatedAt, source.updatedAt);
  const input = mobileCreateInput(request, owner, features, categories, locations, statuses);
  const ready = assets.filter(asset => asset.status === "READY" && !asset.isDeleted);
  const chosen = resolveProductGallerySource(source.images, ready);
  const primaryImage = chosen.kind === "INVENTORY" ? chosen.images[0]?.storageKey : undefined;
  const primaryAsset = chosen.kind === "PHOTO_ASSET" ? chosen.assets[0]?.id : undefined;
  const copied: InventoryFieldsInput["images"] = [...new Map(source.images.map(image => [image.storageKey, image])).values()].map((image, index) => ({
    kind: "copy", sourceStorageKey: image.storageKey, sourceThumbnailKey: image.thumbnailKey, sourceMediumKey: image.mediumKey,
    sourceOriginalHash: image.originalHash, sourceClassification: image.classification, sourceSystem: null, sourceUrl: null,
    type: image.type, isPrimary: image.storageKey === primaryImage, sortOrder: index,
  }));
  for (const asset of ready) {
    if (!bucket) throw new Error("Photo storage unavailable");
    copied.push({kind:"copy", sourceBucket:bucket, sourceStorageKey:photoAssetS3Key(asset.photoBatchId,asset.id,"PROCESSED",extensionForMimeType(asset.declared.PROCESSED.mimeType)),
      sourceThumbnailKey:null,sourceMediumKey:null,sourceOriginalHash:asset.declared.PROCESSED.sha256,sourceClassification:null,sourceSystem:null,sourceUrl:null,
      type:asset.inventoryImageType === "DAMAGE" ? "DAMAGE" : "NORMAL",isPrimary:asset.id === primaryAsset,sortOrder:copied.length});
  }
  input.images = [...copied, ...input.images.map((image,index)=>({...image,sortOrder:copied.length+index,isPrimary:image.isPrimary && !copied.some(photo=>photo.type==="NORMAL")}))];
  return input;
}
