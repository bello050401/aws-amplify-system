/** Read-only BELLO audit. The app's source is BELLO; never call ZAICO or read its credentials. */
import { readFileSync, writeFileSync } from "node:fs";
import { AppSyncClient, ListGraphqlApisCommand } from "@aws-sdk/client-appsync";
import { AmplifyClient, GetAppCommand, GetBranchCommand } from "@aws-sdk/client-amplify";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DETAIL_FIELDS } from "../mobile/src/domain/detailFields";
import { normalizeImageRecord, type InventoryImageRecord } from "../lib/inventory/imageTypes";
import { mobileInventoryPhotos } from "../lib/mobile/inventoryPhotos";
import type { WebPhotoAssetView } from "../lib/photoRegistration/webAdapter";

async function main() {
  const output = process.env.MOBILE_AUDIT_OUTPUT;
  if (!output) throw new Error("MOBILE_AUDIT_OUTPUT is required");
  const config = JSON.parse(readFileSync("amplify_outputs.json", "utf8"));
  const region = config.data.aws_region;
  const appSync = new AppSyncClient({ region });
  let apiId: string | undefined, nextToken: string | undefined;
  do {
    const page = await appSync.send(new ListGraphqlApisCommand({ nextToken }));
    apiId ??= page.graphqlApis?.find(api => api.uris?.GRAPHQL === config.data.url)?.apiId;
    nextToken = page.nextToken;
  } while (nextToken && !apiId);
  if (!apiId) throw new Error("Configured API not found");
  const db = new DynamoDBClient({ region }), doc = DynamoDBDocumentClient.from(db);
  const names: string[] = []; let start: string | undefined;
  do { const page = await db.send(new ListTablesCommand({ ExclusiveStartTableName: start })); names.push(...page.TableNames ?? []); start = page.LastEvaluatedTableName; } while (start);
  const matches = names.filter(name => name.startsWith(`Inventory-${apiId}-`));
  if (matches.length !== 1) throw new Error("Inventory table not uniquely resolved");
  const amplify = new AmplifyClient({ region });
  const [app, branch] = await Promise.all([
    amplify.send(new GetAppCommand({ appId: "d4hkkg7dty2du" })),
    amplify.send(new GetBranchCommand({ appId: "d4hkkg7dty2du", branchName: "claude/inventory-management-system-5vbvc7" })),
  ]);
  const env = { ...app.app?.environmentVariables, ...branch.branch?.environmentVariables };
  if (env.PHOTO_REGISTRATION_INVENTORY_TABLE_NAME && env.PHOTO_REGISTRATION_INVENTORY_TABLE_NAME !== matches[0]) throw new Error("Photo and inventory environments do not match");
  const keys = [...new Set(["id", "sku", "images", "sourceSystem", "sourceInventoryId", "customFields", "name", "quantity", "unit", "note", "barcode", "plannedSalePrice", ...DETAIL_FIELDS.filter(field => !field.custom).map(field => field.key)])];
  const rows: Record<string, any>[] = []; let cursor: Record<string, any> | undefined;
  do {
    const page = await doc.send(new ScanCommand({ TableName: matches[0], ExclusiveStartKey: cursor,
      ProjectionExpression: keys.map((_, i) => `#f${i}`).join(","), ExpressionAttributeNames: Object.fromEntries(keys.map((key, i) => [`#f${i}`, key])),
    })); rows.push(...page.Items ?? []); cursor = page.LastEvaluatedKey;
  } while (cursor);
  const counts = rows.map(row => Array.isArray(row.images) ? row.images.length : 0);
  const samples = [...rows].sort((a, b) => (b.images?.length ?? 0) - (a.images?.length ?? 0)).slice(0, 3);
  const compared = [];
  for (const row of samples) {
    const photoAssets: WebPhotoAssetView[] = [];
    if (env.PHOTO_REGISTRATION_TABLE_NAME) {
      let batchCursor: Record<string, any> | undefined;
      do {
        const batches = await doc.send(new QueryCommand({ TableName: env.PHOTO_REGISTRATION_TABLE_NAME, IndexName: "GSI2", KeyConditionExpression: "GSI2PK = :key", ExpressionAttributeValues: { ":key": `BATCH_INVENTORY#${row.id}` }, ExclusiveStartKey: batchCursor }));
        for (const batch of batches.Items ?? []) {
          let assetCursor: Record<string, any> | undefined;
          do {
            const assets = await doc.send(new QueryCommand({ TableName: env.PHOTO_REGISTRATION_TABLE_NAME, KeyConditionExpression: "PK = :key AND begins_with(SK, :prefix)", ExpressionAttributeValues: { ":key": batch.PK, ":prefix": "ASSET#" }, ExclusiveStartKey: assetCursor }));
            // URLs here are inert placeholders: this validates projection/counts,
            // not image transport. Actual routes sign BELLO storage paths.
            photoAssets.push(...(assets.Items ?? []).filter(asset => !asset.isDeleted && asset.status === "READY").map(asset => ({
              ...asset, id: asset.id ?? String(asset.SK).slice(6),
              thumbnailUrl: "https://bello.invalid/thumbnail", processedUrl: "https://bello.invalid/processed",
            } as WebPhotoAssetView)));
            assetCursor = assets.LastEvaluatedKey;
          } while (assetCursor);
        }
        batchCursor = batches.LastEvaluatedKey;
      } while (batchCursor);
    }
    const normalized: InventoryImageRecord[] = (row.images ?? []).filter(Boolean).map(normalizeImageRecord);
    const images = await mobileInventoryPhotos(normalized, photoAssets, async () => "https://bello.invalid/image");
    const expectedCount = new Set(normalized.map(image => image.storageKey)).size + new Set(photoAssets.map(asset => asset.id)).size;
    compared.push({ inventoryId: row.id, sku: row.sku,
      belloInventoryImages: normalized.length, belloReadyPhotoAssets: photoAssets.length,
      appImageCount: images.length, expectedUniqueImageCount: expectedCount, countsMatch: images.length === expectedCount,
      productImages: images.filter(image => image.type === "NORMAL").length,
      damageImages: images.filter(image => image.type === "DAMAGE").length,
    });
  }
  const report = { checkedAt: new Date().toISOString(), mode: "read-only", source: "BELLO", zaicoRequests: 0, secretReads: 0, writes: 0, liveInventoryCount: rows.length,
    mobileDataCompatibility: {
      invalidQuantities: rows.filter(row => row.quantity != null && (!Number.isSafeInteger(row.quantity) || row.quantity < 0)).length,
      invalidPlannedPrices: rows.filter(row => row.plannedSalePrice != null && (typeof row.plannedSalePrice !== "number" || !Number.isFinite(row.plannedSalePrice))).length,
      missingNames: rows.filter(row => typeof row.name !== "string" || !row.name.trim()).length,
      customFieldParseFailures: rows.filter(row => { if (typeof row.customFields !== "string") return false; try { JSON.parse(row.customFields); return false; } catch { return true; } }).length,
    },
    inventoryImageMaximum: Math.max(0, ...counts), moreThanTenImages: counts.filter(count => count > 10).length,
    moreThanHundredImages: counts.filter(count => count > 100).length, photoStorageConfigured: Boolean(env.PHOTO_REGISTRATION_TABLE_NAME),
    samples: compared, limitation: "BELLO stored-data and projection audit only. Image transport, deployed mobile endpoints, and real-device writes are not verified by this audit." };
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(JSON.stringify({ auditFailed: true, errorType: error?.name ?? "Error" })); process.exitCode = 1; });
