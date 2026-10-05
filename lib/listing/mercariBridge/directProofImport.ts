const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Za-z0-9_-]{1,100}$/;
const B005757 = { requestId: "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825",
  accountReference: "evkhihBFFNn5hukMS9s36H", remoteId: "2JXjWPRVBxjZ2K2vgTGNqy",
  inventoryCode: "B005757" };

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
    ((value.remoteId === "2JXePE4ke8UCBTj6mxc4cf" && value.inventoryCode === "B005795") ||
      (value.requestId === B005757.requestId &&
        value.accountReference === B005757.accountReference &&
        value.remoteId === B005757.remoteId &&
        value.inventoryCode === B005757.inventoryCode)) &&
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

/** Stop stale reports before POST and never display a former request after switching IDs. */
export async function reportSavedDirectProofInTab(input: {
  requestId: string;
  file: Pick<File, "size" | "text">;
  isCurrent: () => boolean;
  refresh: () => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<"REPORTED" | "STALE"> {
  const { requestId, file, isCurrent, refresh, fetchImpl = fetch } = input;
  if (!HASH.test(requestId) || file.size < 1 || file.size > 2048)
    throw Error("Invalid direct proof file");
  const exportRecord: unknown = JSON.parse(await file.text());
  if (!isCurrent()) return "STALE";
  const path = `/api/inventory/mercari-bridge/read?requestId=${requestId}`;
  const owned = await fetchImpl(path, { method: "GET", credentials: "same-origin",
    headers: { "x-bello-mercari-bridge": "READ_EXISTING" },
    cache: "no-store", redirect: "error" });
  if (!isCurrent()) return "STALE";
  if (!owned.ok) throw Error("Read request is unavailable");
  const dispatch = await owned.json();
  if (!isCurrent()) return "STALE";
  if (dispatch?.ok !== true || !object(exportRecord) || exportRecord.requestId !== requestId)
    throw Error("Read request and proof differ");
  const report = directProofReportFromExport(exportRecord, dispatch.job);
  const saved = await fetchImpl(path, { method: "POST", credentials: "same-origin",
    headers: { "x-bello-mercari-bridge": "READ_EXISTING", "Content-Type": "application/json" },
    body: JSON.stringify(report), cache: "no-store", redirect: "error" });
  if (!isCurrent()) return "STALE";
  if (!saved.ok) throw Error("Direct proof was not accepted");
  const receipt = await saved.json();
  if (!isCurrent()) return "STALE";
  if (receipt?.ok !== true || receipt.stored !== true ||
      receipt.requestId !== requestId || receipt.attemptId !== report.attemptId ||
      receipt.readStatus !== "DIRECT_HTTP_READ_CONFIRMED" || receipt.listingConfirmed !== false)
    throw Error("Direct proof receipt differs");
  await refresh();
  return isCurrent() ? "REPORTED" : "STALE";
}
