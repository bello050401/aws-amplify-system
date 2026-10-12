import "server-only";

import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { PrivateDraftLinkRepository,
  WebHttpPrivateDraftLink } from "./webHttpPrivateDraftLink.ts";

async function get(inventoryId: string): Promise<WebHttpPrivateDraftLink | null> {
  const { data, errors } = await serverDataClient.models.MercariBridgeHttpDraftLink
    .get({ inventoryId }, inventoryAuthMode);
  if (errors?.length) throw Error("Shops HTTP private draft link lookup failed");
  return data as WebHttpPrivateDraftLink | null;
}

async function createIfAbsent(link: WebHttpPrivateDraftLink): Promise<void> {
  const result = await serverDataClient.graphql({
    query: `mutation CreateMercariBridgeHttpDraftLink($input: CreateMercariBridgeHttpDraftLinkInput!, $condition: ModelMercariBridgeHttpDraftLinkConditionInput) {
      createMercariBridgeHttpDraftLink(input: $input, condition: $condition) {
        inventoryId remoteDraftId
      }
    }`,
    variables: { input: link,
      condition: { remoteDraftId: { attributeExists: false } } },
    authMode: "userPool",
  });
  const response = result as { data?: { createMercariBridgeHttpDraftLink?:
    { inventoryId: string; remoteDraftId: string } | null }; errors?: unknown };
  if (response.errors ||
      response.data?.createMercariBridgeHttpDraftLink?.inventoryId !==
        link.inventoryId ||
      response.data?.createMercariBridgeHttpDraftLink?.remoteDraftId !==
        link.remoteDraftId)
    throw Error("Shops HTTP private draft link conditional create failed");
}

export const webHttpPrivateDraftLinkRepository:
  PrivateDraftLinkRepository = { get, createIfAbsent };
