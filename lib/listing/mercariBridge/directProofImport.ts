const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Za-z0-9_-]{1,100}$/;
const REMOTE_ID = "2JXePE4ke8UCBTj6mxc4cf";
const INVENTORY_CODE = "B005795";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type DirectProofDispatch = {
  requestId: string;
  operation: "READ_EXISTING";
  accountReference: string;
  remoteId: string;
  inventoryCode: string;
};

/** The local exporter has already checked the saved, pinned HTTP evidence. */
export function directProofReportFromExport(value: unknown, dispatch: unknown) {
  if (!object(value) || !object(dispatch))
    throw Error("保存済みの読取記録とBELLOの依頼が一致しません。");
  const exactFields = Object.keys(value).sort().join(",") ===
    "accountReference,attemptId,inventoryCode,kind,listingConfirmed,reasonCode,remoteId,requestId,schemaVersion,status";
  const validProof = exactFields && value.schemaVersion === 1 &&
    value.kind === "BELLO_PINNED_DIRECT_READ_PROOF" &&
    typeof value.requestId === "string" && HASH.test(value.requestId) &&
    typeof value.attemptId === "string" && UUID.test(value.attemptId) &&
    typeof value.accountReference === "string" && REFERENCE.test(value.accountReference) &&
    value.remoteId === REMOTE_ID && value.inventoryCode === INVENTORY_CODE &&
    value.status === "DIRECT_HTTP_READ_CONFIRMED" &&
    value.reasonCode === "PINNED_HTTP_200_MATCHED" && value.listingConfirmed === false;
  const ownedTarget = dispatch.operation === "READ_EXISTING" &&
    dispatch.requestId === value.requestId &&
    dispatch.accountReference === value.accountReference &&
    dispatch.remoteId === value.remoteId && dispatch.inventoryCode === value.inventoryCode;
  if (!validProof || !ownedTarget)
    throw Error("保存済みの読取記録とBELLOの依頼が一致しません。");
  return { requestId: value.requestId, attemptId: value.attemptId,
    accountReference: value.accountReference, remoteId: value.remoteId,
    status: "DIRECT_HTTP_READ_CONFIRMED" as const, comparison: null,
    reasonCode: "PINNED_HTTP_200_MATCHED" as const };
}
