import "server-only";

import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { WebHttpShopSendSlot, WebHttpSendAttempt,
  WebHttpSendReservationRepository } from "./webHttpSendReservation";

async function getSlot(shopId: string): Promise<WebHttpShopSendSlot | null> {
  const { data, errors } = await serverDataClient.models.MercariBridgeHttpShopSendSlot
    .get({ shopId }, inventoryAuthMode);
  if (errors?.length) throw Error("Shops HTTP send slot lookup failed");
  return data as WebHttpShopSendSlot | null;
}

async function createSlot(slot: WebHttpShopSendSlot): Promise<void> {
  const result = await serverDataClient.graphql({
    query: `mutation CreateMercariBridgeHttpShopSendSlot($input: CreateMercariBridgeHttpShopSendSlotInput!, $condition: ModelMercariBridgeHttpShopSendSlotConditionInput) {
      createMercariBridgeHttpShopSendSlot(input: $input, condition: $condition) { shopId revision attemptId }
    }`,
    variables: { input: slot,
      condition: { revision: { attributeExists: false } } },
    authMode: "userPool",
  });
  const response = result as { data?: { createMercariBridgeHttpShopSendSlot?:
    { shopId: string; revision: number; attemptId: string } | null }; errors?: unknown };
  const saved = response.data?.createMercariBridgeHttpShopSendSlot;
  if (response.errors || saved?.shopId !== slot.shopId ||
      saved.revision !== slot.revision || saved.attemptId !== slot.attemptId)
    throw Error("Shops HTTP send slot conditional create failed");
}

async function updateSlot(previous: WebHttpShopSendSlot,
  next: WebHttpShopSendSlot): Promise<void> {
  const result = await serverDataClient.graphql({
    query: `mutation UpdateMercariBridgeHttpShopSendSlot($input: UpdateMercariBridgeHttpShopSendSlotInput!, $condition: ModelMercariBridgeHttpShopSendSlotConditionInput) {
      updateMercariBridgeHttpShopSendSlot(input: $input, condition: $condition) { shopId revision attemptId }
    }`,
    variables: { input: next, condition: {
      revision: { eq: previous.revision },
      attemptId: { eq: previous.attemptId },
    } },
    authMode: "userPool",
  });
  const response = result as { data?: { updateMercariBridgeHttpShopSendSlot?:
    { shopId: string; revision: number; attemptId: string } | null }; errors?: unknown };
  const saved = response.data?.updateMercariBridgeHttpShopSendSlot;
  if (response.errors || saved?.shopId !== next.shopId ||
      saved.revision !== next.revision || saved.attemptId !== next.attemptId)
    throw Error("Shops HTTP send slot conditional update failed");
}

async function getAttempt(requestId: string): Promise<WebHttpSendAttempt | null> {
  const { data, errors } = await serverDataClient.models.MercariBridgeHttpSendAttempt
    .get({ requestId }, inventoryAuthMode);
  if (errors?.length) throw Error("Shops HTTP send attempt lookup failed");
  return data as WebHttpSendAttempt | null;
}

async function createAttempt(attempt: WebHttpSendAttempt): Promise<void> {
  const result = await serverDataClient.graphql({
    query: `mutation CreateMercariBridgeHttpSendAttempt($input: CreateMercariBridgeHttpSendAttemptInput!, $condition: ModelMercariBridgeHttpSendAttemptConditionInput) {
      createMercariBridgeHttpSendAttempt(input: $input, condition: $condition) { requestId attemptId }
    }`,
    variables: { input: attempt,
      condition: { attemptId: { attributeExists: false } } },
    authMode: "userPool",
  });
  const response = result as { data?: { createMercariBridgeHttpSendAttempt?:
    { requestId: string; attemptId: string } | null }; errors?: unknown };
  const saved = response.data?.createMercariBridgeHttpSendAttempt;
  if (response.errors || saved?.requestId !== attempt.requestId ||
      saved.attemptId !== attempt.attemptId)
    throw Error("Shops HTTP send attempt conditional create failed");
}

export const webHttpSendReservationRepository: WebHttpSendReservationRepository = {
  getSlot, createSlot, updateSlot, getAttempt, createAttempt,
};
