import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  ListTablesCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent } from "node:https";
import { cleanupDeletedInventoryListings } from "../../lib/mediaMaintenance/deletedInventoryListings";
import { DynamoPhotoRegistrationRepository } from "../../lib/photoRegistration/awsRepository";
async function main() {
  if (process.env.BELLO_AUDIT_SCRATCH !== "1")
    throw Error("Scratch opt-in required");
  const raw = new DynamoDBClient({
      region: "us-west-2",
      credentials: fromIni({ profile: "Bello" }),
      maxAttempts: 3,
      requestHandler: new NodeHttpHandler({
        httpsAgent: new Agent({ keepAlive: false }),
        connectionTimeout: 10000,
        requestTimeout: 20000,
      }),
    }),
    db = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
  const prefix = "Bello-QA-ListingCleanup-" + randomUUID().slice(0, 8) + "-",
    created: string[] = [],
    t = {
      inventory: prefix + "Inventory",
      history: prefix + "History",
      draft: prefix + "Draft",
      channel: prefix + "Channel",
      photo: prefix + "Photo",
      workflow: prefix + "Workflow",
    };
  const report = {
    startedAt: new Date().toISOString(),
    passed: [] as string[],
    cleanup: "",
  };
  const save = () =>
    writeFileSync(
      "artifacts/system-audit-20261101/listing-cleanup-aws.json",
      JSON.stringify(report, null, 2),
    );
  const check = (s: string) => {
    report.passed.push(s);
    save();
    console.log("PASS", s);
  };
  const put = (TableName: string, Item: any) =>
    db.send(new PutCommand({ TableName, Item }));
  const get = async (TableName: string, Key: any) =>
    (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true })))
      .Item;
  try {
    for (const [model, TableName] of Object.entries(t)) {
      const hash =
        model === "photo" ? "PK" : model === "workflow" ? "pk" : "id";
      const defs: any[] = [{ AttributeName: hash, AttributeType: "S" }],
        schema: any[] = [{ AttributeName: hash, KeyType: "HASH" }];
      if (model === "photo") {
        defs.push({ AttributeName: "SK", AttributeType: "S" });
        schema.push({ AttributeName: "SK", KeyType: "RANGE" });
      }
      if (model === "history")
        defs.push(
          { AttributeName: "inventoryId", AttributeType: "S" },
          { AttributeName: "changedAt", AttributeType: "S" },
        );
      await raw.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: defs,
          KeySchema: schema,
          ...(model === "history"
            ? {
                GlobalSecondaryIndexes: [
                  {
                    IndexName: "inventoryHistoriesByInventoryIdAndChangedAt",
                    KeySchema: [
                      { AttributeName: "inventoryId", KeyType: "HASH" },
                      { AttributeName: "changedAt", KeyType: "RANGE" },
                    ],
                    Projection: { ProjectionType: "ALL" as const },
                  },
                ],
              }
            : {}),
        }),
      );
      created.push(TableName);
    }
    await Promise.all(
      created.map((TableName) =>
        waitUntilTableExists(
          { client: raw, maxWaitTime: 90, minDelay: 1, maxDelay: 3 },
          { TableName },
        ),
      ),
    );
    async function fixture(kind: string) {
      const inventoryId = randomUUID(),
        id = randomUUID(),
        batchId = randomUUID(),
        assetId = batchId + "#A#" + randomUUID();
      const state = { PK: "LISTING#" + id, SK: "SELECTION_STATE" },
        asset = { PK: "BATCH#" + batchId, SK: "ASSET#000001#" + assetId };
      await put(t.photo, {
        PK: "BATCH#" + batchId,
        SK: "BATCH#" + batchId,
        id: batchId,
        entityType: "PhotoBatch",
        inventoryId,
      });
      await put(t.photo, {
        ...asset,
        id: assetId,
        photoBatchId: batchId,
        entityType: "PhotoAsset",
        listingSelectionCount: kind === "shared" ? 2 : 1,
        status: "READY",
        isDeleted: false,
      });
      await put(t.photo, { ...state, selectionRevision: 3 });
      await put(t.photo, {
        PK: "LISTING#" + id,
        SK: "SELECTION_ROW#000001#" + assetId,
        photoAssetId: assetId,
      });
      if (kind !== "missingDraft")
        await put(t.draft, {
          id,
          inventoryId,
          updatedAt: "v1",
          images: ["synthetic-owned-image"],
        });
      if (kind !== "noReceipt")
        await put(t.history, {
          id: randomUUID(),
          inventoryId,
          changedAt: new Date().toISOString(),
          fieldName: "削除",
          newValue: "削除済み",
        });
      if (kind === "live") await put(t.inventory, { id: inventoryId });
      if (kind === "active")
        await put(t.channel, {
          id: randomUUID(),
          inventoryId,
          listingDraftId: id,
          status: "ACTIVE",
          updatedAt: "v1",
        });
      if (kind === "bound")
        await put(t.workflow, {
          pk: "ECONVENI#MANUAL_LINK#" + inventoryId,
          productId: "remote",
        });
      return { id, inventoryId, assetId, state, asset };
    }
    const dead = await fixture("shared"),
      missing = await fixture("missingDraft"),
      live = await fixture("live"),
      unknown = await fixture("noReceipt"),
      active = await fixture("active"),
      bound = await fixture("bound");
    const dry = await cleanupDeletedInventoryListings(db, t, new Date(), true);
    assert.equal(dry.eligible, 2);
    assert.ok(await get(t.draft, { id: dead.id }));
    assert.equal((await get(t.photo, dead.asset))?.listingSelectionCount, 2);
    check("dry run identifies only explicit deletions and makes no changes");
    const done = await cleanupDeletedInventoryListings(db, t);
    assert.equal(done.removedDrafts, 1);
    assert.equal(done.releasedSelections, 2);
    assert.deepEqual(done.failures, []);
    assert.equal(await get(t.draft, { id: dead.id }), undefined);
    assert.equal((await get(t.photo, dead.asset))?.listingSelectionCount, 1);
    assert.equal((await get(t.photo, missing.asset))?.listingSelectionCount, 0);
    check(
      "draft and stale selection removed atomically; shared asset retains other owner",
    );
    for (const f of [live, unknown, active, bound])
      assert.equal((await get(t.photo, f.asset))?.listingSelectionCount, 1);
    check(
      "live inventory, missing deletion receipt, active listing and e-conveni binding protected",
    );
    const repo = new DynamoPhotoRegistrationRepository({
      ddb: db,
      tableName: t.photo,
      inventoryTableName: t.inventory,
      now: () => new Date(),
    });
    await assert.rejects(
      repo.getListingSelectionState(dead.id),
      /permanently deleted/,
    );
    await assert.rejects(
      repo.applyListingSelection({
        kind: "REPLACE_SELECTION",
        listingId: dead.id,
        nextSelectionRevision: 4,
        rows: [],
        refCountIncrements: [],
        refCountDecrements: [],
        conditions: [],
      } as any),
    );
    check(
      "retired selection cannot be revived by delayed pre-delete browser request",
    );
    const again = await cleanupDeletedInventoryListings(db, t);
    assert.equal(again.releasedSelections, 0);
    assert.equal((await get(t.photo, dead.asset))?.listingSelectionCount, 1);
    check("repeated cleanup does not decrement shared reference twice");
    const race = await fixture("race");
    let injected = false;
    const raced = {
      send: async (c: any) => {
        if (c instanceof TransactWriteCommand && !injected) {
          injected = true;
          await db.send(
            new UpdateCommand({
              TableName: t.photo,
              Key: race.asset,
              UpdateExpression: "SET listingSelectionCount=:n",
              ExpressionAttributeValues: { ":n": 2 },
            }),
          );
        }
        return db.send(c);
      },
    } as any;
    const result = await cleanupDeletedInventoryListings(raced, t);
    assert.equal(result.removedDrafts, 0);
    assert.ok(await get(t.draft, { id: race.id }));
    assert.equal((await get(t.photo, race.asset))?.listingSelectionCount, 2);
    check(
      "concurrent reference change rolls back draft deletion and selection removal together",
    );
  } finally {
    for (const TableName of created)
      await raw.send(new DeleteTableCommand({ TableName }));
    report.cleanup = "scratch deletion accepted";
    save();
    const remaining =
      (await raw.send(new ListTablesCommand({}))).TableNames?.filter((n) =>
        n.startsWith(prefix),
      ) || [];
    if (remaining.length) {
      report.cleanup = "deletion in progress; verify table absence separately";
    } else report.cleanup = "all scratch tables confirmed absent";
    save();
  }
}
main().catch((e) => {
  console.error(e.name, e.message);
  process.exitCode = 1;
});
