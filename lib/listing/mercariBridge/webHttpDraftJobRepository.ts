import "server-only";

import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { WebHttpDraftJob, WebHttpDraftJobRepository } from "./webHttpDraftJob";

async function getJob(requestId: string): Promise<WebHttpDraftJob | null> {
  const { data, errors } = await serverDataClient.models.MercariBridgeHttpDraftJob
    .get({ requestId }, inventoryAuthMode);
  if (errors?.length) throw Error("Shops HTTP draft job lookup failed");
  return data as WebHttpDraftJob | null;
}

async function createJob(job: WebHttpDraftJob): Promise<void> {
  const result = await serverDataClient.graphql({
    query: `mutation CreateMercariBridgeHttpDraftJob($input: CreateMercariBridgeHttpDraftJobInput!, $condition: ModelMercariBridgeHttpDraftJobConditionInput) {
      createMercariBridgeHttpDraftJob(input: $input, condition: $condition) { requestId }
    }`,
    variables: { input: job,
      condition: { snapshotFingerprint: { attributeExists: false } } },
    authMode: "userPool",
  });
  const response = result as { data?: { createMercariBridgeHttpDraftJob?:
    { requestId: string } | null }; errors?: unknown };
  if (response.errors ||
      response.data?.createMercariBridgeHttpDraftJob?.requestId !== job.requestId)
    throw Error("Shops HTTP draft job conditional create failed");
}

export const webHttpDraftJobRepository: WebHttpDraftJobRepository = { getJob, createJob };
