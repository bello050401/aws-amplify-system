import { createHash } from "node:crypto";
import type { InventoryFieldsInput } from "@/app/actions/inventory";
import type { InventoryDetail, MasterOption, StatusOption } from "@/lib/inventory/queries";
import { ALL_EXTENDED_FIELDS } from "@/lib/inventory/extendedFields";
import { assertInventoryVersion } from "@/lib/inventory/conditionalUpdate";
import { DETAIL_FIELDS } from "@/mobile/src/domain/detailFields";
import { validateDraft, type InventoryDraft } from "@/mobile/src/domain/inventory";
import type { SaveRequest } from "@/mobile/src/domain/editor";
import type { MobileFeatures } from "./accessPolicy";

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

/** Accept only the mobile editor contract; no images, arbitrary columns, or custom metadata. */
export function parseMobileSave(raw: unknown, id: string): SaveRequest {
  if (!object(raw) || !uuid.test(id) || raw.id !== id || typeof raw.mutationId !== "string" || !uuid.test(raw.mutationId) ||
      typeof raw.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(raw.expectedUpdatedAt)) ||
      Object.keys(raw).some(key => !["id", "mutationId", "expectedUpdatedAt", "draft"].includes(key))) return invalid();
  const draft = raw.draft;
  if (!object(draft) || !object(draft.details) || Object.keys(draft).some(key => key !== "details" && !draftKeys.includes(key as typeof draftKeys[number])) ||
      draftKeys.some(key => typeof draft[key] !== "string" || (draft[key] as string).length > 16000)) return invalid();
  for (const [key, value] of Object.entries(draft.details)) {
    if (!DETAIL_FIELDS.some(field => field.key === key) || typeof value !== "string" || value.length > 16000) return invalid();
  }
  if (validateDraft(draft as InventoryDraft)) return invalid();
  // GraphQL Int, not JavaScript's wider safe integer range.
  if (Number(draft.quantity) > 2147483647 || Number(draft.details.purchaseQuantity ?? 0) > 2147483647) return invalid();
  return { id, mutationId: raw.mutationId, expectedUpdatedAt: raw.expectedUpdatedAt, draft: draft as InventoryDraft };
}

function receiptFor(request: SaveRequest, owner: string) {
  const draft = request.draft;
  const values = [...draftKeys.map(key => [key, draft[key]]), ["details", Object.entries(draft.details).sort(([a], [b]) => a.localeCompare(b))]];
  return { owner, mutationId: request.mutationId, fingerprint: createHash("sha256").update(JSON.stringify([request.id, request.expectedUpdatedAt, values])).digest("hex") };
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
  const { draft } = request;
  if (draft.statusId && draft.statusId !== row.statusId && !statuses.some(status => status.id === draft.statusId)) return invalid();
  const input: InventoryFieldsInput = {
    name: draft.name, quantity: Number(draft.quantity), unit: draft.unit, note: draft.note,
    categoryId: masterId(draft.category, row.categoryId, categories), locationId: masterId(draft.location, row.locationId, locations), statusId: draft.statusId,
    expectedUpdatedAt: request.expectedUpdatedAt, purchasePrice: row.purchasePrice, salePrice: row.salePrice,
    images: row.images.map(image => ({ ...image, kind: "uploaded" as const })),
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
  input.customFields![MOBILE_WRITE_RECEIPT] = receiptFor(request, owner);
  return input;
}
