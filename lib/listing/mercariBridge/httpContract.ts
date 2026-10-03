import { createHash } from "node:crypto";
import type { ExistingProductBinding, ExistingReadJob } from "./readRequest";

export type ExistingReadDispatch = {
  requestId: string;
  operation: "READ_EXISTING";
  accountReference: string;
  remoteId: string;
  inventoryCode: string;
  expectedFields: Record<string, string | number>;
};

const reference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Return only the comparison inputs needed by the PC, after checking the same ADMIN owns both records. */
export function existingReadDispatchForOwner(job: ExistingReadJob | null, binding: ExistingProductBinding | null,
  principal: string | null): ExistingReadDispatch | null {
  if (!job || !binding || !principal || principal !== job.requestedBy ||
      principal !== binding.requestedBy || job.operation !== "READ_EXISTING" ||
      job.status !== "CONNECTOR_NOT_CONFIGURED" || binding.source !== "USER_REVIEWED_UI" ||
      binding.inventoryId !== job.inventoryId || binding.shopId !== job.shopId ||
      binding.remoteId !== job.remoteId || !reference(job.shopId) || !reference(job.remoteId) ||
      !/^[a-f0-9]{64}$/.test(job.requestId) ||
      createHash("sha256").update(job.snapshotJson).digest("hex") !== job.snapshotFingerprint) return null;
  let snapshot: unknown;
  try { snapshot = JSON.parse(job.snapshotJson); } catch { return null; }
  if (!object(snapshot) || snapshot.operation !== "READ_EXISTING" ||
      snapshot.shopId !== job.shopId || snapshot.remoteId !== job.remoteId ||
      snapshot.inventoryId !== job.inventoryId || !object(snapshot.expected)) return null;
  const expected = snapshot.expected;
  if (!reference(expected.inventoryCode) || typeof expected.title !== "string" ||
      typeof expected.description !== "string" ||
      !Number.isSafeInteger(expected.quantity) || Number(expected.quantity) < 0 ||
      (expected.priceYen !== null && (!Number.isSafeInteger(expected.priceYen) ||
        Number(expected.priceYen) < 0))) return null;
  const expectedFields: Record<string, string | number> = {
    title: expected.title,
    description: expected.description,
    quantity: expected.quantity as number,
  };
  if (typeof expected.priceYen === "number") expectedFields.priceYen = expected.priceYen;
  return { requestId: job.requestId, operation: "READ_EXISTING", accountReference: job.shopId,
    remoteId: job.remoteId, inventoryCode: expected.inventoryCode, expectedFields };
}
