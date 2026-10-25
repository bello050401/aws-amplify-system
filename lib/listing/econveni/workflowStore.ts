import "server-only";
import { randomUUID } from "node:crypto";
import { GetCommand, UpdateCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export type EconveniChannel = "YAHOO" | "MERCARI_SHOPS";
export type RemoteState = "NOT_STARTED" | "PENDING" | "SUCCEEDED" | "FAILED" | "VERIFY_REQUIRED";
export type ChannelState = { state: RemoteState; operation?: "PUBLISH" | "STOP"; operationId?: string;
  remoteStatus?: "ACTIVE" | "INACTIVE"; listingId?: string; listingUrl?: string; publishedAt?: string; stoppedAt?: string;
  stopEffect?: "ENDED" | "REMOVED"; errorCode?: string };
export type EconveniWorkflow = {
  pk: string; inventoryId: string; revision: number; updatedAt: string;
  save: { state: RemoteState; productId?: string; fingerprint?: string; operationId?: string;
    expected?: { fields:Record<string,string>; imageHashes:string[] }; errorCode?:string };
  channels: Record<EconveniChannel, ChannelState>;
  approvals?: Partial<Record<EconveniChannel,{token:string;actor:string;operation:"PUBLISH"|"STOP";fingerprint:string;expiresAt:number}>>;
};
type Client = Pick<DynamoDBDocumentClient, "send">;
export class EconveniWorkflowError extends Error {
  constructor(public code: "BUSY_OR_STOPPED" | "WAIT_INTERVAL" | "VERIFY_REQUIRED" | "STATE_UNAVAILABLE" | "INVALID_TRANSITION" | "REMOVAL_NOT_AUTHORIZED", public readyAt?: number) { super(code); }
}
export const ECONVENI_INTERVAL_MS = 30_000;
const LEASE_MS = 180_000;
const ACCOUNT = "ECONVENI#ACCOUNT";
const pending = (state: RemoteState) => state === "PENDING" || state === "VERIFY_REQUIRED";
export function initialEconveniWorkflow(inventoryId: string): EconveniWorkflow {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(inventoryId)) throw new EconveniWorkflowError("INVALID_TRANSITION");
  return { pk: "ECONVENI#INVENTORY#" + inventoryId, inventoryId, revision: 0, updatedAt: "", save: { state: "NOT_STARTED" }, channels: { YAHOO: { state: "NOT_STARTED" }, MERCARI_SHOPS: { state: "NOT_STARTED" } } };
}
/** Pure preflight. A pending save/publish is NEVER reset by a second button press. */
export function reserveEconveniOperation(current: EconveniWorkflow, kind: "SAVE" | EconveniChannel, fingerprint: string, operationId: string, operation: "PUBLISH" | "STOP" = "PUBLISH"): EconveniWorkflow | null {
  if (!fingerprint || !operationId) throw new EconveniWorkflowError("INVALID_TRANSITION");
  if (pending(current.save.state) || Object.values(current.channels).some(c => pending(c.state))) throw new EconveniWorkflowError("VERIFY_REQUIRED");
  if (kind === "SAVE") {
    if (current.save.state === "SUCCEEDED" && current.save.fingerprint === fingerprint) return null;
    // Retain the immutable product binding on updates; never fall back to adding another product.
    return { ...current, approvals:{}, save: { state: "PENDING", productId:current.save.productId, fingerprint, operationId } };
  }
  if (current.save.state !== "SUCCEEDED" || !current.save.productId || operation === "PUBLISH" && current.save.fingerprint !== fingerprint) throw new EconveniWorkflowError("INVALID_TRANSITION");
  const channel = current.channels[kind];
  if(operation === "STOP") {
    if(channel.remoteStatus === "INACTIVE" && channel.state === "SUCCEEDED") return null;
    if(!channel.listingId || channel.remoteStatus !== "ACTIVE") throw new EconveniWorkflowError("INVALID_TRANSITION");
  } else if(channel.state === "SUCCEEDED" && channel.remoteStatus !== "INACTIVE") return null;
  return { ...current, channels: { ...current.channels, [kind]: { ...channel, state: "PENDING", operation, operationId, errorCode: undefined } } };
}

/** Shared Yahoo/Shops lock and send timestamp. Requires a dedicated server-only table binding.
 * Callers must commit PENDING before any external write. Uncertain commits prohibit sending.
 * Expired leases allow another worker to reconcile, never to resend a PENDING operation.
 */
export class EconveniWorkflowStore {
  private readonly owner = randomUUID();
  readonly key: string;
  constructor(private readonly inventoryId: string, private readonly client: Client, private readonly table: string) {
    this.key = initialEconveniWorkflow(inventoryId).pk;
    if (!table) throw new EconveniWorkflowError("STATE_UNAVAILABLE");
  }
  async read(): Promise<EconveniWorkflow | null> {
    const result = await this.client.send(new GetCommand({ TableName: this.table, Key: { pk: this.key }, ConsistentRead: true }));
    return result.Item as EconveniWorkflow ?? null;
  }
  async acquire(recover=false) {
    const now = Date.now();
    try {
      await this.client.send(new UpdateCommand({ TableName: this.table, Key: { pk: ACCOUNT },
        UpdateExpression: "SET #owner=:owner, leaseUntil=:until",
        ConditionExpression: (recover?'':'attribute_not_exists(blockedReason) AND ')+'(attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
        ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": this.owner, ":until": now + LEASE_MS, ":now": now } }));
    } catch { throw new EconveniWorkflowError("BUSY_OR_STOPPED"); }
  }
  async resumeAfterVerifiedLogin(){
    await this.client.send(new UpdateCommand({TableName:this.table,Key:{pk:ACCOUNT},UpdateExpression:'REMOVE blockedReason, blockedAt',
      ConditionExpression:'#owner=:owner AND leaseUntil > :now',ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':owner':this.owner,':now':Date.now()}}));
  }
  async commit(previous: EconveniWorkflow | null, next: EconveniWorkflow, reserveSend = false) {
    if (next.inventoryId !== this.inventoryId || next.pk !== this.key || (previous && previous.inventoryId !== this.inventoryId)) throw new EconveniWorkflowError("INVALID_TRANSITION");
    const now = Date.now();
    if (reserveSend) {
      const result = await this.client.send(new GetCommand({ TableName: this.table, Key: { pk: ACCOUNT }, ConsistentRead: true }));
      const readyAt = Number(result.Item?.lastSentAt ?? 0) + ECONVENI_INTERVAL_MS;
      if (readyAt > now) throw new EconveniWorkflowError("WAIT_INTERVAL", readyAt);
    }
    const value = { ...next, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date(now).toISOString() };
    const names = { "#owner": "owner" };
    const condition = "#owner=:owner AND leaseUntil > :now AND attribute_not_exists(blockedReason)";
    const values = { ":owner": this.owner, ":now": now };
    try {
      await this.client.send(new TransactWriteCommand({ ClientRequestToken: randomUUID(), TransactItems: [
        reserveSend ? { Update: { TableName: this.table, Key: { pk: ACCOUNT }, UpdateExpression: "SET lastSentAt=:now, leaseUntil=:until",
          ConditionExpression: condition + " AND (attribute_not_exists(lastSentAt) OR lastSentAt <= :cutoff)",
          ExpressionAttributeNames: names, ExpressionAttributeValues: { ...values, ":cutoff": now - ECONVENI_INTERVAL_MS, ":until":now+LEASE_MS } } } :
          { ConditionCheck: { TableName: this.table, Key: { pk: ACCOUNT }, ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
        { Put: { TableName: this.table, Item: value, ConditionExpression: previous ? "revision=:revision" : "attribute_not_exists(pk)",
          ...(previous ? { ExpressionAttributeValues: { ":revision": previous.revision } } : {}) } },
      ] }));
      return value;
    } catch { throw new EconveniWorkflowError("STATE_UNAVAILABLE"); }
  }
  async stop(reason: "AUTH_REQUIRED" | "ACCESS_DENIED" | "ADDITIONAL_AUTH") {
    if (!["AUTH_REQUIRED", "ACCESS_DENIED", "ADDITIONAL_AUTH"].includes(reason)) throw new EconveniWorkflowError("INVALID_TRANSITION");
    // No auto-clear: successful re-authentication and explicit administrator recovery are required.
    await this.client.send(new UpdateCommand({ TableName: this.table, Key: { pk: ACCOUNT },
      UpdateExpression: "SET blockedReason=:reason, blockedAt=:at", ConditionExpression: "#owner=:owner",
      ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": this.owner, ":reason": reason, ":at": new Date().toISOString() } }));
  }
  async release() {
    try { await this.client.send(new UpdateCommand({ TableName: this.table, Key: { pk: ACCOUNT }, UpdateExpression: "REMOVE #owner, leaseUntil", ConditionExpression: "#owner=:owner",
      ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": this.owner } })); }
    catch { /* Expiry releases the lease. Pending operations still require reconciliation. */ }
  }
}
