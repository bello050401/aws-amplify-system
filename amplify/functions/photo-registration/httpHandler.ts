import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoPhotoRegistrationRepository } from "../../../lib/photoRegistration/awsRepository";
import { S3PhotoStorage } from "../../../lib/photoRegistration/awsStorage";
import { PhotoRegistrationService } from "../../../lib/photoRegistration/service";
import type { TrustedClaims } from "../../../lib/photoRegistration/ports";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const repository = new DynamoPhotoRegistrationRepository({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  tableName: required("PHOTO_REGISTRATION_TABLE_NAME"),
  inventoryTableName: required("INVENTORY_TABLE_NAME"),
  now: () => new Date(),
});
const service = new PhotoRegistrationService({
  repository,
  storage: new S3PhotoStorage({ s3Client: new S3Client({}), bucketName: required("PHOTO_REGISTRATION_BUCKET_NAME") }),
  authConfig: { photoDeviceGroupDeployed: process.env.PHOTO_DEVICE_GROUP_DEPLOYED === "true" },
});

function groupsFromClaim(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed.map(String); } catch { /* Cognito can emit a plain value. */ }
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const claims = (event.requestContext as unknown as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } }).authorizer?.jwt?.claims ?? {};
  const trusted: TrustedClaims = {
    userId: String(claims.sub ?? ""),
    groups: groupsFromClaim(claims["cognito:groups"]),
    deviceId: typeof claims["custom:deviceId"] === "string" ? claims["custom:deviceId"] : null,
  };
  if (!trusted.userId) return json(401, { ok: false, error: { code: "AUTH_REQUIRED", message: "authenticated identity required" } });
  const operation = event.pathParameters?.operation ?? event.rawPath.split("/").filter(Boolean).at(-1) ?? "";
  let input: unknown = {};
  try { input = event.body ? JSON.parse(event.body) : {}; }
  catch { return json(400, { ok: false, error: { code: "INVALID_INPUT", message: "invalid JSON" } }); }
  const result = await dispatch(operation, input, trusted);
  return json(result.ok ? 200 : result.error === "PERMISSION_DENIED" ? 403 : 400, result.ok
    ? { ok: true, value: result.value }
    : { ok: false, error: { code: result.error, message: result.message, field: result.field ?? null } });
};

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });

async function dispatch(operation: string, input: unknown, claims: TrustedClaims) {
  switch (operation) {
    case "createPhotoBatch": return service.createPhotoBatch(input, claims);
    case "requestPhotoAssetUploads": return service.requestPhotoAssetUploads(input, claims);
    case "completePhotoAssetUpload": return service.completePhotoAssetUpload(input, claims);
    case "completePhotoBatch": return service.completePhotoBatch(input, claims);
    case "linkPhotoBatchToInventory": return service.linkPhotoBatchToInventory(input, claims);
    case "listUnregisteredBatches": {
      const args = input as { limit?: number; cursor?: string | null };
      return service.listUnregisteredBatches(args.limit ?? 20, args.cursor ?? null, claims);
    }
    case "listBatchesForInventory": {
      const args = input as { inventoryId: string; limit?: number; cursor?: string | null };
      return service.listBatchesForInventory(args.inventoryId, args.limit ?? 20, args.cursor ?? null, claims);
    }
    default: return { ok: false as const, error: "INVALID_INPUT" as const, message: `unknown operation ${operation}` };
  }
}
