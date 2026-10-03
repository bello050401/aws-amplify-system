import "server-only";

import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { ExistingProductBinding, ExistingReadJob, ReadRequestRepository } from "./readRequest";
import type { ResultRepository, StoredReadResult } from "./resultAcceptance";
import { collectReadResultPages } from "./resultPages";

async function getBinding(inventoryId: string): Promise<ExistingProductBinding | null> {
  const { data, errors } = await serverDataClient.models.MercariBridgeBinding.get({ inventoryId }, inventoryAuthMode);
  if (errors?.length) throw new Error("Mercari bridge binding read failed");
  return data as ExistingProductBinding | null;
}

async function createBinding(binding: ExistingProductBinding): Promise<void> {
  const result = await serverDataClient.graphql({
    query: `mutation CreateMercariBridgeBinding($input: CreateMercariBridgeBindingInput!, $condition: ModelMercariBridgeBindingConditionInput) {
      createMercariBridgeBinding(input: $input, condition: $condition) { inventoryId }
    }`,
    // Amplify excludes custom primary keys from ModelConditionInput. This required non-key
    // field exists on every saved binding, so its absence also prevents overwriting one.
    variables: { input: binding, condition: { shopId: { attributeExists: false } } },
    authMode: "userPool",
  });
  const response = result as { data?: { createMercariBridgeBinding?: { inventoryId: string } | null }; errors?: unknown };
  if (response.errors || response.data?.createMercariBridgeBinding?.inventoryId !== binding.inventoryId)
    throw new Error("Mercari bridge binding conditional create failed");
}

async function getJob(requestId: string): Promise<ExistingReadJob | null> {
  const { data, errors } = await serverDataClient.models.MercariBridgeReadJob.get({ requestId }, inventoryAuthMode);
  if (errors?.length) throw new Error("Mercari bridge read job lookup failed");
  return data as ExistingReadJob | null;
}

async function createJob(job: ExistingReadJob): Promise<void> {
  const result = await serverDataClient.graphql({
    query: `mutation CreateMercariBridgeReadJob($input: CreateMercariBridgeReadJobInput!, $condition: ModelMercariBridgeReadJobConditionInput) {
      createMercariBridgeReadJob(input: $input, condition: $condition) { requestId }
    }`,
    // The requestId primary key is unavailable in ModelConditionInput; every job has this field.
    variables: { input: job, condition: { snapshotFingerprint: { attributeExists: false } } },
    authMode: "userPool",
  });
  const response = result as { data?: { createMercariBridgeReadJob?: { requestId: string } | null }; errors?: unknown };
  if (response.errors || response.data?.createMercariBridgeReadJob?.requestId !== job.requestId)
    throw new Error("Mercari bridge read job conditional create failed");
}

export const mercariBridgeReadRepository: ReadRequestRepository = { getBinding, createBinding, getJob, createJob };

async function getResult(resultId: string): Promise<StoredReadResult | null> {
  const { data, errors } = await serverDataClient.models.MercariBridgeReadResult.get({ resultId }, inventoryAuthMode);
  if (errors?.length) throw new Error("Mercari bridge result lookup failed");
  return data as StoredReadResult | null;
}

async function createResult(row: StoredReadResult): Promise<void> {
  const result = await serverDataClient.graphql({
    query: `mutation CreateMercariBridgeReadResult($input: CreateMercariBridgeReadResultInput!, $condition: ModelMercariBridgeReadResultConditionInput) {
      createMercariBridgeReadResult(input: $input, condition: $condition) { resultId }
    }`,
    // requestId is required and is not this model's primary key.
    variables: { input: row, condition: { requestId: { attributeExists: false } } },
    authMode: "userPool",
  });
  const response = result as { data?: { createMercariBridgeReadResult?: { resultId: string } | null }; errors?: unknown };
  if (response.errors || response.data?.createMercariBridgeReadResult?.resultId !== row.resultId)
    throw new Error("Mercari bridge result conditional create failed");
}

/** The ADMIN-authenticated PC route uses these same user-pool-scoped model operations. */
export const mercariBridgeResultRepository: ResultRepository = { getBinding, getJob, getResult, createResult };

/** Exact request-ID index lookup for a bounded, owner-checked ADMIN result view. */
export async function listReadResultsForRequest(requestId: string): Promise<StoredReadResult[]> {
  return collectReadResultPages(async (nextToken) => {
    const { data, errors, nextToken: continuation } = await serverDataClient.models.MercariBridgeReadResult
      .listMercariBridgeReadResultByRequestId({ requestId }, { limit: 50, nextToken, ...inventoryAuthMode });
    if (errors?.length) throw new Error("Mercari bridge result lookup failed");
    return { items: data as StoredReadResult[], nextToken: continuation };
  });
}
