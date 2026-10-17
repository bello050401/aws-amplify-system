/** Shared save contract for Web/mobile callers. The caller retains staff authorization. */
export class InventorySaveError extends Error {
  constructor(readonly code: "CONFLICT" | "UNCONFIRMED") {
    super(code === "CONFLICT"
      ? "別の端末または同期で商品が更新されています。入力内容を控え、最新の内容を確認してから保存してください。"
      : "保存結果を確認できません。変更内容を保持したまま、最新の商品情報を確認してください。");
  }
}

export function assertInventoryVersion(expected: unknown, current: string): asserts expected is string {
  if (typeof expected !== "string" || !Number.isFinite(Date.parse(expected)) || expected !== current) throw new InventorySaveError("CONFLICT");
}

export interface InventoryWriteResult { data?: { updateInventory?: { id: string; updatedAt: string } | null }; errors?: { errorType?: string; message?: string }[] }
export type InventoryRevisionWriter = (request: { query: string; variables: { input: Record<string, unknown>; condition: { updatedAt: { eq: string } } }; authMode: "userPool" }) => Promise<InventoryWriteResult>;
function isConditionalFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const errors = (value as { errors?: unknown }).errors;
  return Array.isArray(errors) && errors.some(error => error && typeof error.errorType === "string" && /ConditionalCheckFailed/.test(error.errorType));
}

/** The condition is checked by AppSync/DynamoDB at the write, not just in a preceding read. */
export async function writeInventoryRevision(writer: InventoryRevisionWriter, input: Record<string, unknown>, expectedUpdatedAt: string): Promise<{ id: string; updatedAt: string }> {
  if (!input.id || !Number.isFinite(Date.parse(expectedUpdatedAt))) throw new InventorySaveError("CONFLICT");
  let result: InventoryWriteResult;
  try {
    result = await writer({ query: `mutation SaveInventoryRevision($input: UpdateInventoryInput!, $condition: ModelInventoryConditionInput!) {
      updateInventory(input: $input, condition: $condition) { id updatedAt }
    }`, variables: { input, condition: { updatedAt: { eq: expectedUpdatedAt } } }, authMode: "userPool" });
  } catch (error) { throw new InventorySaveError(isConditionalFailure(error) ? "CONFLICT" : "UNCONFIRMED"); }
  if (isConditionalFailure(result)) throw new InventorySaveError("CONFLICT");
  const saved = result.data?.updateInventory;
  if (result.errors?.length || !saved || saved.id !== input.id || !Number.isFinite(Date.parse(saved.updatedAt))) throw new InventorySaveError("UNCONFIRMED");
  return saved;
}

export interface InventoryDeleteResult { data?: { deleteInventory?: { id: string } | null }; errors?: { errorType?: string; message?: string }[] }
export async function deleteInventoryRevision(writer: (request: Parameters<InventoryRevisionWriter>[0]) => Promise<InventoryDeleteResult>, id: string, expectedUpdatedAt: string): Promise<void> {
  if (!id || !Number.isFinite(Date.parse(expectedUpdatedAt))) throw new InventorySaveError("CONFLICT");
  let result: InventoryDeleteResult;
  try {
    result = await writer({ query: `mutation DeleteInventoryRevision($input: DeleteInventoryInput!, $condition: ModelInventoryConditionInput!) {
      deleteInventory(input: $input, condition: $condition) { id }
    }`, variables: { input: { id }, condition: { updatedAt: { eq: expectedUpdatedAt } } }, authMode: "userPool" });
  } catch (error) { throw new InventorySaveError(isConditionalFailure(error) ? "CONFLICT" : "UNCONFIRMED"); }
  if (isConditionalFailure(result)) throw new InventorySaveError("CONFLICT");
  if (result.errors?.length || result.data?.deleteInventory?.id !== id) throw new InventorySaveError("UNCONFIRMED");
}
