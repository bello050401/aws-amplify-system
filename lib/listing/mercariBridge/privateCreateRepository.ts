import "server-only";

import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { PrivateCreateEvent, PrivateCreateEventRepository } from "./privateCreateTrial";

async function getEvent(eventId: string): Promise<PrivateCreateEvent | null> {
  const { data, errors } = await serverDataClient.models.MercariBridgePrivateCreateEvent
    .get({ eventId }, inventoryAuthMode);
  if (errors?.length) throw Error("Private-create event lookup failed");
  return data as PrivateCreateEvent | null;
}

async function createEvent(event: PrivateCreateEvent): Promise<void> {
  const result = await serverDataClient.graphql({
    query: `mutation CreateMercariBridgePrivateCreateEvent($input: CreateMercariBridgePrivateCreateEventInput!, $condition: ModelMercariBridgePrivateCreateEventConditionInput) {
      createMercariBridgePrivateCreateEvent(input: $input, condition: $condition) { eventId }
    }`,
    variables: { input: event, condition: { attemptId: { attributeExists: false } } },
    authMode: "userPool",
  });
  const response = result as { data?: { createMercariBridgePrivateCreateEvent?:
    { eventId: string } | null }; errors?: unknown };
  if (response.errors || response.data?.createMercariBridgePrivateCreateEvent?.eventId !== event.eventId)
    throw Error("Private-create event conditional create failed");
}

export const privateCreateEventRepository: PrivateCreateEventRepository = { getEvent, createEvent };
