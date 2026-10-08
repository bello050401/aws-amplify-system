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

export function pcRecordCurrent(record: { key: string; epoch: number },
  current: PcTargetEpoch) {
  return record.key === current.key && record.epoch === current.value;
}

export type PcVisibilityStatus = "UNREAD" | "PENDING" | "PUBLIC_VERIFIED" |
  "STOP_VERIFIED" | "RELIST_VERIFIED" | "UNKNOWN";

/** Choose the one visible action without treating a BELLO record as Shops proof. */
export function pcVisibilityControl(featureEnabled: boolean,
  status: PcVisibilityStatus, hasTargetPublicProof: boolean,
  relistUiObserved = false): {
    action: "STOP" | "RELIST" | null; enabled: boolean; label: string;
  } {
  if (!featureEnabled)
    return { action: null, enabled: false, label: "Shops公開状態の確認待ち" };
  if (status === "UNREAD" || status === "PENDING")
    return { action: "STOP", enabled: true,
      label: "既存Shops商品の確認ジョブをPCへ渡す" };
  if (status === "PUBLIC_VERIFIED" || status === "RELIST_VERIFIED")
    return { action: "STOP", enabled: hasTargetPublicProof,
      label: hasTargetPublicProof ? "出品停止" : "Shops公開状態の確認待ち" };
  if (status === "STOP_VERIFIED")
    return { action: "RELIST", enabled: relistUiObserved,
      label: "出品" };
  return { action: null, enabled: false, label: "Shops側の結果確認待ち" };
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
