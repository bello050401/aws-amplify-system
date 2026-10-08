import { B005396_INVENTORY_ID } from "./b005396GeneralPreparation.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";

// These IDs were read back after the browser's two CreateProductDraft calls.
// This path is deliberately read-only: another create would add a third draft.
export const B005396_CORRECT_DRAFT_ID = "2JXsGZ7vdfvq7bwbM7dAw9";
export const B005396_EMPTY_DRAFT_ID = "2JXsGZ5tqLr5Z5SMBXSVUe";

const GET_PRODUCT_DRAFT = `query GetProductDraft($id: String!) {
  productDraft(id: $id) {
    id
    name
    description
    price
    thumbnails { id }
    variants { quantity skuCode }
  }
}`;

type GraphqlRequest = { operationName: "GetProductDraft"; query: string;
  variables: { id: string } };
export type AuthenticatedDraftReadTransport = {
  /** Must be supplied by a separately verified authenticated context. */
  post: (request: GraphqlRequest) => Promise<{ status: number; body: unknown }>;
};
type Result = { ok: true; code: "EXISTING_DRAFT_OBSERVED_NO_SEND";
  draftId: typeof B005396_CORRECT_DRAFT_ID; duplicateDraftObserved: true;
  imageIdentityVerified: false; listingConfirmed: false;
  allowCreate: false; allowUpdate: false } |
  { ok: false; code: "INVALID_JOB" | "AUTH_TRANSPORT_UNAVAILABLE" |
    "REMOTE_READ_UNVERIFIED" | "DRAFT_MISMATCH";
    allowCreate: false; allowUpdate: false };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function readDraft(result: { status: number; body: unknown }, id: string) {
  if (result.status !== 200 || !object(result.body) ||
      "errors" in result.body || !object(result.body.data) ||
      !object(result.body.data.productDraft) ||
      result.body.data.productDraft.id !== id) return null;
  return result.body.data.productDraft;
}

/** Reconcile the known B005396 drafts against one frozen BELLO job; never mutate Shops. */
export async function readObservedB005396Draft(job: WebHttpDraftJob,
  transport: AuthenticatedDraftReadTransport | null): Promise<Result> {
  if (!initialWebHttpExecutionState(job) ||
      job.inventoryId.toLowerCase() !== B005396_INVENTORY_ID)
    return { ok: false, code: "INVALID_JOB", allowCreate: false,
      allowUpdate: false };
  if (!transport || typeof transport.post !== "function")
    return { ok: false, code: "AUTH_TRANSPORT_UNAVAILABLE",
      allowCreate: false, allowUpdate: false };
  let pack: Record<string, unknown>;
  try {
    const snapshot: unknown = JSON.parse(job.snapshotJson);
    if (!object(snapshot) || !object(snapshot.pack)) throw Error("Invalid snapshot");
    pack = snapshot.pack;
  } catch {
    return { ok: false, code: "INVALID_JOB", allowCreate: false,
      allowUpdate: false };
  }
  let correctResult: { status: number; body: unknown };
  let emptyResult: { status: number; body: unknown };
  try {
    correctResult = await transport.post({ operationName: "GetProductDraft",
      query: GET_PRODUCT_DRAFT, variables: { id: B005396_CORRECT_DRAFT_ID } });
    emptyResult = await transport.post({ operationName: "GetProductDraft",
      query: GET_PRODUCT_DRAFT, variables: { id: B005396_EMPTY_DRAFT_ID } });
  } catch {
    return { ok: false, code: "REMOTE_READ_UNVERIFIED",
      allowCreate: false, allowUpdate: false };
  }
  const correct = readDraft(correctResult, B005396_CORRECT_DRAFT_ID);
  const empty = readDraft(emptyResult, B005396_EMPTY_DRAFT_ID);
  if (!correct || !empty)
    return { ok: false, code: "REMOTE_READ_UNVERIFIED",
      allowCreate: false, allowUpdate: false };
  const variants = correct.variants;
  const thumbnails = correct.thumbnails;
  if (correct.name !== pack.title ||
      correct.description !== pack.description ||
      correct.price !== pack.priceYen ||
      !Array.isArray(variants) || variants.length !== 1 ||
      !object(variants[0]) || variants[0].quantity !== pack.quantity ||
      variants[0].skuCode !== pack.managementCode ||
      !Array.isArray(thumbnails) || thumbnails.length !== 1 ||
      !object(thumbnails[0]) || typeof thumbnails[0].id !== "string" ||
      !thumbnails[0].id ||
      empty.name !== pack.title || empty.price !== 0 ||
      !Array.isArray(empty.thumbnails) || empty.thumbnails.length !== 0)
    return { ok: false, code: "DRAFT_MISMATCH",
      allowCreate: false, allowUpdate: false };
  return { ok: true, code: "EXISTING_DRAFT_OBSERVED_NO_SEND",
    draftId: B005396_CORRECT_DRAFT_ID, duplicateDraftObserved: true,
    imageIdentityVerified: false, listingConfirmed: false,
    allowCreate: false, allowUpdate: false };
}
