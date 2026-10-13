import "server-only";
import { observedProductContentFingerprint, type ObservedProductRead } from "./webHttpObservedProductContract.ts";
import type { WebHttpProductBinding, WebHttpProductStopPorts } from "./webHttpProductStop.ts";

type Repository = WebHttpProductStopPorts["repository"] & {
  verifyProductStop: (id: string, attemptId: string, shopId: string, productId: string,
    fingerprint: string, now: string, desiredStatus?: "STATUS_OPENED" | "STATUS_UNOPENED") => Promise<void>;
};

/** State refresh resolves an acknowledged remote change without ever resending.
 * It also keeps the recovery control reachable when the observed status changed.
 */
export async function reconcilePendingProductVisibility(binding: WebHttpProductBinding,
  product: ObservedProductRead, requestedBy: string, repository: Repository,
  clock = Date.now): Promise<"CLEAR" | "PENDING"> {
  const id = await repository.getPendingProductStop(binding.shopId, binding.remoteProductId);
  if (!id) return "CLEAR";
  const attempt = await repository.getAttempt(id);
  if (!attempt || attempt.requestId !== id || attempt.requestedBy !== requestedBy ||
      attempt.inventoryId !== binding.inventoryId || attempt.shopId !== binding.shopId ||
      attempt.remoteProductId !== binding.remoteProductId) return "PENDING";
  if (attempt.status === "RESERVED_NO_SEND" && clock() >= Date.parse(attempt.sendBeforeAt)) {
    await repository.cancelUnclaimedProductStop(attempt);
    return "CLEAR";
  }
  const desiredStatus = attempt.desiredProductStatus ?? "STATUS_UNOPENED";
  if (attempt.status !== "SEND_CLAIMED_RESULT_UNKNOWN" || product.shopId !== binding.shopId ||
      product.id !== binding.remoteProductId || product.variants[0]?.skuCode !== binding.managementCode ||
      product.status !== desiredStatus || !attempt.productContentFingerprint ||
      observedProductContentFingerprint(product) !== attempt.productContentFingerprint) return "PENDING";
  await repository.verifyProductStop(id, attempt.attemptId, binding.shopId, product.id,
    attempt.productContentFingerprint, new Date(clock()).toISOString(), desiredStatus);
  return "CLEAR";
}
