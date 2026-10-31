import { candidateKey } from "./identity";
import type { SaleCandidate, SaleChannel } from "./model";

export type DeletedSaleCandidate = {
  id: string;
  state: "DELETED";
  channel: SaleChannel;
  orderHash?: string;
  deletedAt: string;
  deletedBy: string;
  updatedAt: string;
  deletionVersion: 1;
};

// Deliberate allowlist: no product, financial, mail, customer or inventory data.
// No expiry: removing the suppression key could resurrect the same old order.
export function deletedCandidateRecord(
  current: SaleCandidate | DeletedSaleCandidate,
  actor: string,
  now: string,
): DeletedSaleCandidate {
  if (current.state !== "PENDING" && current.state !== "DELETED")
    throw Object.assign(Error("CANDIDATE_NOT_PENDING"), {
      name: "ConditionalCheckFailedException",
    });
  const orderHash =
    "orderHash" in current
      ? current.orderHash
      : "orderId" in current && current.orderId
        ? candidateKey(current.channel, current.orderId, "order")
        : undefined;
  return {
    id: current.id,
    state: "DELETED",
    channel: current.channel,
    ...(orderHash ? { orderHash } : {}),
    deletedAt: current.deletedAt || now,
    deletedBy: current.deletedBy || actor,
    updatedAt: now,
    deletionVersion: 1,
  };
}
