export type PcTargetEpoch = { key: string; value: number };
export type PinnedPublicProof = {
  inventoryId: string; remoteId: string; observedAt: string;
};

export function pcTargetKey(inventoryId: string, remoteId: string | null | undefined) {
  return `${inventoryId.toLowerCase()}::${remoteId ?? ""}`;
}

export function samePcTargetEpoch(current: PcTargetEpoch, started: PcTargetEpoch) {
  return current.key === started.key && current.value === started.value;
}

export function pinnedPublicProofForTarget(record: {
  key: string; status: string; proof: PinnedPublicProof | null;
}, inventoryId: string, remoteId: string | null | undefined) {
  return record.key === pcTargetKey(inventoryId, remoteId) &&
    ["PUBLIC_VERIFIED", "RELIST_VERIFIED"].includes(record.status) &&
    record.proof?.inventoryId.toLowerCase() === inventoryId.toLowerCase() &&
    record.proof.remoteId === remoteId &&
    Number.isFinite(Date.parse(record.proof.observedAt)) ? record.proof : null;
}
