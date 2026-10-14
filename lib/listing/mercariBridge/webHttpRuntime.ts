import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand, UpdateSecretVersionStageCommand } from "@aws-sdk/client-secrets-manager";
import { randomUUID } from "node:crypto";
import { parseRefreshMaterial, refreshWebHttpSessionOnce } from "./webHttpSessionRefresh.ts";
import outputs from "../../../amplify_outputs.json";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob";
import { DynamoWebHttpSendReservationRepository } from "./webHttpSendReservationRepository";
import type { WebHttpProductBinding } from "./webHttpProductStop";

type Config = { region: string; secretArn: string; slotTable: string; attemptTable: string; linkTable: string };
export type RuntimeSession = { cookieHeader: string; expiresAtMs: number };
export function parseRuntimeSession(value: unknown, now = Date.now()): RuntimeSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.shopId !== WEB_HTTP_SHOP_ID ||
      typeof record.expiresAt !== "string" || typeof record.authenticatedAt !== "string" ||
      typeof record.opaqueMaterial !== "string") return null;
  const expiresAtMs = Date.parse(record.expiresAt);
  const authenticatedAt = Date.parse(record.authenticatedAt);
  if (!Number.isSafeInteger(now) || !Number.isFinite(authenticatedAt) || authenticatedAt > now ||
      !Number.isFinite(expiresAtMs) || expiresAtMs <= now + 40_000) return null;
  let material: unknown;
  try { material = JSON.parse(record.opaqueMaterial); } catch { return null; }
  if (!material || typeof material !== "object" || !("cookieHeader" in material) ||
      typeof material.cookieHeader !== "string" || material.cookieHeader.length > 32_768 ||
      /[\r\n\0]/.test(material.cookieHeader)) return null;
  const names = new Set<string>();
  for (const cookie of material.cookieHeader.split(";")) {
    const part = cookie.trim(); const index = part.indexOf("=");
    const name = part.slice(0, index);
    if (index < 1 || !part.slice(index + 1) || !["id_token", "__cf_bm", "_cfuvid"].includes(name) ||
        names.has(name)) return null;
    names.add(name);
  }
  return names.has("id_token") ? { cookieHeader: material.cookieHeader, expiresAtMs } : null;
}

type SessionVersion = { versionId: string; record: unknown };
export type SessionRefreshStore = {
  read: () => Promise<SessionVersion>;
  /** Durable single-use claim. A lost refresh response cannot be retried. */
  claim: (versionId: string, attemptId: string, now: number) => Promise<boolean>;
  /** Promote only if AWSCURRENT still points to the version we refreshed. */
  replace: (previousVersion: string, attemptId: string, record: unknown) => Promise<void>;
};
export async function readRenewableRuntimeSession(store: SessionRefreshStore, forceRefresh = false,
  fetchPort: typeof fetch = fetch, clock = Date.now): Promise<RuntimeSession | null> {
  const previous = await store.read();
  const fresh = parseRuntimeSession(previous.record, clock());
  if (fresh && !forceRefresh && fresh.expiresAtMs > clock() + 10 * 60_000) return fresh;
  const record = previous.record as Record<string, unknown> | null;
  if (!record || record.schemaVersion !== 1 || record.shopId !== WEB_HTTP_SHOP_ID ||
      typeof record.opaqueMaterial !== "string" || typeof record.authenticatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.authenticatedAt)) || Date.parse(record.authenticatedAt) > clock()) return null;
  let material;
  try { material = parseRefreshMaterial(JSON.parse(record.opaqueMaterial), clock()); } catch { material = null; }
  if (!material) return forceRefresh ? null : fresh;
  const attemptId = randomUUID();
  if (!await store.claim(previous.versionId, attemptId, clock())) {
    // Another invocation may just have completed. Never submit a second refresh.
    const current = await store.read();
    return current.versionId !== previous.versionId ? parseRuntimeSession(current.record, clock()) : fresh;
  }
  // A fresh manual import supersedes this claim; do not consume its predecessor.
  if ((await store.read()).versionId !== previous.versionId) return null;
  const renewed = await refreshWebHttpSessionOnce(material, fetchPort, clock);
  if (!renewed) return null;
  const next = { schemaVersion: 1, shopId: WEB_HTTP_SHOP_ID,
    authenticatedAt: new Date(clock()).toISOString(), expiresAt: new Date(renewed.expiresAtMs).toISOString(),
    opaqueMaterial: JSON.stringify(renewed) };
  try { await store.replace(previous.versionId, attemptId, next); }
  catch {
    // Includes a concurrent manual import or lost acknowledgement after promotion.
    const current = await store.read();
    return current.versionId !== previous.versionId ? parseRuntimeSession(current.record, clock()) : null;
  }
  return parseRuntimeSession(next, clock());
}

/** AWS workload credentials come from the compute role, not the signed-in browser. */
export function createMercariHttpsRuntime() {
  const config = (outputs as unknown as { custom?: { mercariHttps?: Config } }).custom?.mercariHttps;
  if (!config || config.region !== "us-west-2" ||
      !/^arn:aws:secretsmanager:us-west-2:203918843421:secret:bello\/mercari-web-session-staging-[A-Za-z0-9]+$/.test(config.secretArn) ||
      [config.slotTable, config.attemptTable, config.linkTable].some(name => !name))
    return null;
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
  const sm = new SecretsManagerClient({ region: config.region });
  const sessionStore: SessionRefreshStore = {
    read: async () => {
      const secret = await sm.send(new GetSecretValueCommand({ SecretId: config.secretArn, VersionStage: "AWSCURRENT" }));
      if (!secret.VersionId) throw Error("SESSION_VERSION_MISSING");
      return { versionId: secret.VersionId, record: JSON.parse(secret.SecretString ?? "null") };
    },
    claim: async (versionId, attemptId, now) => {
      try {
        await ddb.send(new UpdateCommand({ TableName: config.slotTable,
          Key: { shopId: `AUTH#${WEB_HTTP_SHOP_ID}` },
          UpdateExpression: "SET secretVersion = :version, attemptId = :attempt, leaseUntil = :until",
          ConditionExpression: "attribute_not_exists(secretVersion) OR (secretVersion <> :version AND leaseUntil < :now)",
          ExpressionAttributeValues: { ":version": versionId, ":attempt": attemptId, ":until": now + 60_000, ":now": now } }));
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
        throw Error("SESSION_CLAIM_UNAVAILABLE");
      }
    },
    replace: async (previousVersion, attemptId, record) => {
      await sm.send(new PutSecretValueCommand({ SecretId: config.secretArn,
        ClientRequestToken: attemptId, VersionStages: ["BELLO_REFRESH_PENDING"], SecretString: JSON.stringify(record) }));
      await sm.send(new UpdateSecretVersionStageCommand({ SecretId: config.secretArn, VersionStage: "AWSCURRENT",
        RemoveFromVersionId: previousVersion, MoveToVersionId: attemptId }));
      // The fixed pending label is reused on the next refresh, so no unbounded labels.
    },
  };
  const repository = new DynamoWebHttpSendReservationRepository(ddb,
    { slotTableName: config.slotTable, attemptTableName: config.attemptTable });
  const readBinding = async (inventoryId: string): Promise<WebHttpProductBinding | null> => {
    const response = await ddb.send(new GetCommand({ TableName: config.linkTable,
      Key: { inventoryId }, ConsistentRead: true }));
    if (!response.Item) return null;
    const item = response.Item;
    if (item.inventoryId !== inventoryId || item.shopId !== WEB_HTTP_SHOP_ID ||
        !/^[A-Za-z0-9]{1,64}$/.test(item.remoteProductId) ||
        item.managementCode !== `BELLO_${inventoryId.replace(/-/g, "").toUpperCase()}`)
      throw Error("INVALID_HTTP_LINK");
    return { inventoryId, shopId: item.shopId, remoteProductId: item.remoteProductId,
      managementCode: item.managementCode };
  };
  return { repository, readBinding,
    readSession: async () => readRenewableRuntimeSession(sessionStore),
    refreshSession: async () => readRenewableRuntimeSession(sessionStore, true),
    saveBinding: async (binding: WebHttpProductBinding, requestId: string, verifiedAt: string,
      remoteStatus: "STATUS_OPENED" | "STATUS_UNOPENED") => {
      const previous = await readBinding(binding.inventoryId);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(binding)) throw Error("HTTP_LINK_CONFLICT");
        return;
      }
      await ddb.send(new PutCommand({ TableName: config.linkTable,
        Item: { ...binding, requestId, verifiedAt, remoteStatus,
          createdAt: verifiedAt, updatedAt: verifiedAt, __typename: "MercariBridgeHttpProductLink" },
        ConditionExpression: "attribute_not_exists(inventoryId)" }));
    },
    saveVerifiedState: async (binding: WebHttpProductBinding,
      remoteStatus: "STATUS_OPENED" | "STATUS_UNOPENED") => {
      const now = new Date().toISOString();
      await ddb.send(new UpdateCommand({ TableName: config.linkTable, Key: { inventoryId: binding.inventoryId },
        UpdateExpression: "SET remoteStatus = :status, verifiedAt = :now, updatedAt = :now",
        ConditionExpression: "remoteProductId = :product AND shopId = :shop AND managementCode = :code",
        ExpressionAttributeValues: { ":status": remoteStatus, ":now": now,
          ":product": binding.remoteProductId, ":shop": binding.shopId, ":code": binding.managementCode } }));
    },
  };
}
