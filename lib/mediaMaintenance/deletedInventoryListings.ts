import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

interface Row extends Record<string, unknown> {
  id: string;
  PK: string;
  SK: string;
  entityType: string;
  inventoryId: string;
  photoAssetId: string;
  photoBatchId: string;
  listingDraftId: string;
  status: string;
  updatedAt: string;
  selectionRevision: number;
  listingSelectionCount: number;
  retiredAt?: string;
}
export type DeletedListingTables = {
  inventory: string;
  history: string;
  draft: string;
  channel: string;
  photo: string;
  workflow: string;
};
/** Retire local draft ownership only after an explicit inventory deletion.
 * Remote bindings are retained; any e-conveni binding or active/uncertain listing
 * protects the draft for review. No external marketplace request is made here.
 */
export async function cleanupDeletedInventoryListings(
  db: DynamoDBDocumentClient,
  t: DeletedListingTables,
  now = new Date(),
  dryRun = false,
) {
  const scan = async (table: string) => {
    const rows: Row[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await db.send(
        new ScanCommand({
          TableName: table,
          ConsistentRead: true,
          ExclusiveStartKey: key,
        }),
      );
      rows.push(...((r.Items || []) as Row[]));
      key = r.LastEvaluatedKey;
    } while (key);
    return rows;
  };
  const get = async (table: string, key: Record<string, unknown>) =>
    (
      await db.send(
        new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
      )
    ).Item as Row | undefined;
  const [drafts, photos, channels] = await Promise.all([
    scan(t.draft),
    scan(t.photo),
    scan(t.channel),
  ]);
  const byDraft = new Map(drafts.map((x) => [x.id, x])),
    byAsset = new Map(
      photos.filter((x) => x.entityType === "PhotoAsset").map((x) => [x.id, x]),
    );
  const byBatch = new Map(
    photos.filter((x) => x.entityType === "PhotoBatch").map((x) => [x.id, x]),
  );
  const ids = new Set<string>([
    ...byDraft.keys(),
    ...photos
      .filter((x) => x.SK?.startsWith("SELECTION_ROW#"))
      .map((x) => x.PK.slice(8)),
  ]);
  const result = {
    eligible: 0,
    removedDrafts: 0,
    releasedSelections: 0,
    protected: 0,
    failures: [] as string[],
  };
  for (const id of ids) {
    const draft = byDraft.get(id);
    if (draft && (await get(t.inventory, { id: draft.inventoryId }))) continue;
    const stateKey = { PK: "LISTING#" + id, SK: "SELECTION_STATE" },
      state = await get(t.photo, stateKey);
    const rows: Row[] = [];
    let selectionCursor: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: t.photo,
          ConsistentRead: true,
          KeyConditionExpression: "PK=:p AND begins_with(SK,:s)",
          ExpressionAttributeValues: {
            ":p": stateKey.PK,
            ":s": "SELECTION_ROW#",
          },
          ExclusiveStartKey: selectionCursor,
        }),
      );
      rows.push(...((page.Items || []) as Row[]));
      selectionCursor = page.LastEvaluatedKey;
    } while (selectionCursor);
    const afterState = await get(t.photo, stateKey);
    if (
      state?.selectionRevision !== afterState?.selectionRevision ||
      state?.retiredAt !== afterState?.retiredAt
    ) {
      result.protected++;
      continue;
    }
    const assets = [...new Set<string>(rows.map((x) => x.photoAssetId))].map(
      (x) => byAsset.get(x),
    );
    if (assets.some((x) => !x)) {
      result.protected++;
      continue;
    }
    const parents = new Set<string | undefined>([
      ...(draft ? [draft.inventoryId] : []),
      ...assets.map((x) => byBatch.get(x!.photoBatchId)?.inventoryId),
    ]);
    if (parents.size !== 1) {
      result.protected++;
      continue;
    }
    const inventoryId = [...parents][0];
    if (typeof inventoryId !== "string" || !/^[0-9a-f-]{36}$/i.test(inventoryId)) {
      result.protected++;
      continue;
    }
    if (await get(t.inventory, { id: inventoryId })) continue;
    let cursor: Record<string, unknown> | undefined, receipt: Row | undefined;
    do {
      const r = await db.send(
        new QueryCommand({
          TableName: t.history,
          IndexName: "inventoryHistoriesByInventoryIdAndChangedAt",
          KeyConditionExpression: "inventoryId=:i",
          ExpressionAttributeValues: { ":i": inventoryId },
          ExclusiveStartKey: cursor,
          ScanIndexForward: false,
        }),
      );
      receipt = r.Items?.find(
        (x) => x.fieldName === "削除" && x.newValue === "削除済み",
      ) as Row | undefined;
      cursor = receipt ? undefined : r.LastEvaluatedKey;
    } while (cursor);
    if (!receipt) {
      result.protected++;
      continue;
    }
    const bindings = channels.filter(
      (x) => x.inventoryId === inventoryId || x.listingDraftId === id,
    );
    if (
      bindings.some(
        (x) =>
          ![
            "PAUSED",
            "SOLD",
            "ENDED",
            "ARCHIVED",
            "NOT_PREPARED",
            "DRAFT",
            "READY",
          ].includes(x.status),
      )
    ) {
      result.protected++;
      continue;
    }
    const workflowKeys = ["ECONVENI#INVENTORY#", "ECONVENI#MANUAL_LINK#"].map(
      (prefix) => ({ pk: prefix + inventoryId }),
    );
    if (
      (await Promise.all(workflowKeys.map((key) => get(t.workflow, key)))).some(
        Boolean,
      )
    ) {
      result.protected++;
      continue;
    }
    if (
      (state?.retiredAt && rows.length) ||
      assets.some(
        (x) =>
          !Number.isInteger(x!.listingSelectionCount) ||
          x!.listingSelectionCount < 1,
      )
    ) {
      result.protected++;
      continue;
    }
    const writes: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
      {
        ConditionCheck: {
          TableName: t.inventory,
          Key: { id: inventoryId },
          ConditionExpression: "attribute_not_exists(id)",
        },
      },
      {
        ConditionCheck: {
          TableName: t.history,
          Key: { id: receipt.id },
          ConditionExpression:
            "inventoryId=:i AND fieldName=:f AND newValue=:v",
          ExpressionAttributeValues: {
            ":i": inventoryId,
            ":f": "削除",
            ":v": "削除済み",
          },
        },
      },
      ...workflowKeys.map((Key) => ({
        ConditionCheck: {
          TableName: t.workflow,
          Key,
          ConditionExpression: "attribute_not_exists(pk)",
        },
      })),
      ...bindings.map((x) => ({
        ConditionCheck: {
          TableName: t.channel,
          Key: { id: x.id },
          ConditionExpression: "#s=:s AND updatedAt=:v",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":s": x.status, ":v": x.updatedAt },
        },
      })),
      ...[...new Set(assets.map((x) => x!.photoBatchId))].map((batchId) => {
        const b = byBatch.get(batchId)!;
        return {
          ConditionCheck: {
            TableName: t.photo,
            Key: { PK: b.PK, SK: b.SK },
            ConditionExpression: "inventoryId=:i",
            ExpressionAttributeValues: { ":i": inventoryId },
          },
        };
      }),
      draft
        ? {
            Delete: {
              TableName: t.draft,
              Key: { id },
              ConditionExpression: "inventoryId=:i AND updatedAt=:v",
              ExpressionAttributeValues: {
                ":i": inventoryId,
                ":v": draft.updatedAt,
              },
            },
          }
        : {
            ConditionCheck: {
              TableName: t.draft,
              Key: { id },
              ConditionExpression: "attribute_not_exists(id)",
            },
          },
      {
        Put: {
          TableName: t.photo,
          Item: {
            ...stateKey,
            selectionRevision: Number(state?.selectionRevision || 0) + 1,
            retiredAt: state?.retiredAt || now.toISOString(),
          },
          ConditionExpression: state
            ? "selectionRevision=:v"
            : "attribute_not_exists(PK)",
          ...(state
            ? { ExpressionAttributeValues: { ":v": state.selectionRevision } }
            : {}),
        },
      },
      ...rows.map((x) => ({
        Delete: {
          TableName: t.photo,
          Key: { PK: x.PK, SK: x.SK },
          ConditionExpression: "photoAssetId=:a",
          ExpressionAttributeValues: { ":a": x.photoAssetId },
        },
      })),
      ...assets.map((x) => ({
        Update: {
          TableName: t.photo,
          Key: { PK: x!.PK, SK: x!.SK },
          UpdateExpression:
            "SET listingSelectionCount=listingSelectionCount-:one",
          ConditionExpression: "listingSelectionCount=:count",
          ExpressionAttributeValues: {
            ":one": 1,
            ":count": x!.listingSelectionCount,
          },
        },
      })),
    ];
    if (writes.length > 100) {
      result.protected++;
      continue;
    }
    result.eligible++;
    if (dryRun) continue;
    try {
      await db.send(new TransactWriteCommand({ TransactItems: writes }));
      result.removedDrafts += draft ? 1 : 0;
      result.releasedSelections += assets.length;
    } catch (e) {
      const reasons = (e as { CancellationReasons?: { Code?: string }[] })
        .CancellationReasons;
      if (
        (e as Error).name === "TransactionCanceledException" &&
        reasons?.some((x) => x.Code === "ConditionalCheckFailed") &&
        reasons.every(
          (x) => !x.Code || ["None", "ConditionalCheckFailed"].includes(x.Code),
        )
      ) {
        result.protected++;
      } else result.failures.push(id);
    }
  }
  return result;
}
