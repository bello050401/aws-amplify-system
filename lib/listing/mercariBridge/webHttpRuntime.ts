import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
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

/** AWS workload credentials come from the compute role, not the signed-in browser. */
export function createMercariHttpsRuntime() {
  const config = (outputs as unknown as { custom?: { mercariHttps?: Config } }).custom?.mercariHttps;
  if (!config || config.region !== "us-west-2" ||
      !/^arn:aws:secretsmanager:us-west-2:203918843421:secret:bello\/mercari-web-session-staging-[A-Za-z0-9]+$/.test(config.secretArn) ||
      [config.slotTable, config.attemptTable, config.linkTable].some(name => !name))
    return null;
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
  const sm = new SecretsManagerClient({ region: config.region });
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
    readSession: async () => {
      const secret = await sm.send(new GetSecretValueCommand({ SecretId: config.secretArn,
        VersionStage: "AWSCURRENT" }));
      try { return parseRuntimeSession(JSON.parse(secret.SecretString ?? "null")); }
      catch { return null; }
    },
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
