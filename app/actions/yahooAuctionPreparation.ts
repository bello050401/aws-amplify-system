"use server";

import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail, listCategories } from "@/lib/inventory/queries";
import { getListingDraftForInventory } from "@/lib/listing/service";
import { isEcListingEligible } from "@/lib/listing/ecEligibility";
import { parseYahooAuctionInput, parseYahooSaved, yahooInventoryIdValid, yahooPayloadsMatch,
  type YahooAuctionPayload, type YahooAuctionSaved } from "@/lib/listing/yahooAuction/preparation";
import type { ListingDraftRecord } from "@/lib/listing/types";
import { resolvedYahooEndAt } from "@/lib/listing/yahooAuction/ending";
import { commonChannelPrice } from "@/lib/listing/commonSettings";

type Context = { draft: ListingDraftRecord | null; saved: YahooAuctionSaved | null;
  availableQuantity: number; canPrepare: boolean };
type Failure = { ok: false; code: "FORBIDDEN" | "INVALID_INPUT" | "UNAVAILABLE" | "SOURCE_CHANGED" | "CONFLICT" | "NOT_ELIGIBLE" };

async function readSaved(inventoryId: string): Promise<YahooAuctionSaved | null> {
  const result = await serverDataClient.models.YahooAuctionPreparation.get({ inventoryId }, inventoryAuthMode);
  if (result.errors?.length) throw Error("YAHOO_PREPARATION_READ_FAILED");
  if (!result.data) return null;
  const parsed = parseYahooSaved(result.data);
  if (!parsed || result.data.inventoryId !== inventoryId) throw Error("YAHOO_PREPARATION_INVALID");
  return parsed;
}

/** BELLO data only. This action has no Yahoo endpoint or credentials. */
export async function getYahooAuctionPreparationAction(inventoryId: string): Promise<
  { ok: true; context: Context } | Failure> {
  if (!canEditInventory(await getInventoryRole())) return { ok: false, code: "FORBIDDEN" };
  if (!yahooInventoryIdValid(inventoryId)) return { ok: false, code: "INVALID_INPUT" };
  try {
    const [item, draft, saved] = await Promise.all([
      getInventoryDetail(inventoryId), getListingDraftForInventory(inventoryId), readSaved(inventoryId),
    ]);
    if (!item) return { ok: false, code: "INVALID_INPUT" };
    const category = (await listCategories(item.categoryId)).find(c => c.id === item.categoryId)?.name ?? null;
    const canPrepare = item.quantity > 0 && item.saleEndDate === null &&
      category?.normalize("NFKC").trim() !== "売り切れ" && isEcListingEligible(category);
    return { ok: true, context: { draft, saved, availableQuantity: item.quantity, canPrepare } };
  } catch { return { ok: false, code: "UNAVAILABLE" }; }
}

/** Save only this channel's choices and a server-loaded source snapshot. */
export async function saveYahooAuctionPreparationAction(inventoryId: string, input: unknown,
  expectedRevision: number | null, expectedSourceUpdatedAt: string): Promise<
    { ok: true; saved: YahooAuctionSaved } | Failure> {
  if (!canEditInventory(await getInventoryRole())) return { ok: false, code: "FORBIDDEN" };
  const who = await getCurrentInventoryUserEmail();
  if (!who) return { ok: false, code: "FORBIDDEN" };
  const parsed = parseYahooAuctionInput(input);
  if (!parsed || !yahooInventoryIdValid(inventoryId) ||
      expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
    return { ok: false, code: "INVALID_INPUT" };
  const contextResult = await getYahooAuctionPreparationAction(inventoryId);
  if (!contextResult.ok) return contextResult;
  const { draft, saved, availableQuantity, canPrepare } = contextResult.context;
  if (!canPrepare || parsed.quantity > availableQuantity) return { ok: false, code: "NOT_ELIGIBLE" };
  if (!draft || draft.updatedAt !== expectedSourceUpdatedAt) return { ok: false, code: "SOURCE_CHANGED" };
  if ((saved?.revision ?? null) !== expectedRevision) return { ok: false, code: "CONFLICT" };
  const payload: YahooAuctionPayload = { schemaVersion: 1, input: { ...parsed, endAtJst: resolvedYahooEndAt(parsed) },
    source: { draftId: draft.id, draftUpdatedAt: draft.updatedAt, images: draft.images,
      shippingMethod: draft.shippingMethod, commonCategoryId: draft.commonCategoryId ?? null,
      commonPriceYen: commonChannelPrice(draft, 'YAHOO') } };
  const revision = (expectedRevision ?? 0) + 1;
  const action = expectedRevision === null ? "createYahooAuctionPreparation" : "updateYahooAuctionPreparation";
  const inputType = expectedRevision === null ? "CreateYahooAuctionPreparationInput" : "UpdateYahooAuctionPreparationInput";
  try {
    const result = await serverDataClient.graphql({
      query: `mutation SaveYahooPreparation($input: ${inputType}!, $condition: ModelYahooAuctionPreparationConditionInput) {
        ${action}(input: $input, condition: $condition) { inventoryId payload revision updatedAt }
      }`,
      variables: { input: { inventoryId, payload: JSON.stringify(payload), revision, updatedBy: who },
        condition: expectedRevision === null ? { revision: { attributeExists: false } } : { revision: { eq: expectedRevision } } },
      authMode: "userPool",
    }) as { data?: Record<string, unknown>; errors?: unknown };
    const record = result.errors ? null : parseYahooSaved(result.data?.[action]);
    if (record && record.revision === revision && yahooPayloadsMatch(record.payload, payload))
      return { ok: true, saved: record };
  } catch { /* Read back once after an uncertain acknowledgement; never repeat the write. */ }
  try {
    const current = await readSaved(inventoryId);
    if (current?.revision === revision && yahooPayloadsMatch(current.payload, payload))
      return { ok: true, saved: current };
    if ((current?.revision ?? null) !== expectedRevision) return { ok: false, code: "CONFLICT" };
  } catch { /* Preserve the input on the client. */ }
  return { ok: false, code: "UNAVAILABLE" };
}
