import "server-only";
import { createRuntimeRecord, getRuntimeRecord } from "./store";
import { eventKey } from "./policy";
export const withdrawalKey = (id: string) => "UNSEND#" + eventKey(id).slice(6);
export async function isWithdrawn(pk: string, id: string) {
  return !!(await getRuntimeRecord(pk, withdrawalKey(id)));
}
export async function markWithdrawn(pk: string, id: string) {
  await createRuntimeRecord({ pk, sk: withdrawalKey(id), at: Date.now() });
}
