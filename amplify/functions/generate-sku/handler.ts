import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

const SKU_PREFIX = "B";
const SKU_DIGITS = 6; // B000001 .. B999999, matches spec §2's example format

// One fixed row in the counter table (provisioned in amplify/backend.ts).
// The table exists solely for this counter — it is not part of the
// Inventory domain model and is never exposed through the GraphQL API.
const COUNTER_PARTITION_KEY = "inventory-sku";

/**
 * Atomically increments the shared SKU counter and returns the next SKU.
 *
 * `ADD counterValue :incr` is a native DynamoDB atomic counter update —
 * concurrent calls each get a distinct, strictly increasing value with no
 * read-modify-write race, and DynamoDB never applies two `ADD`s to the
 * same value. This is the standard, documented pattern for race-free
 * sequence generation on DynamoDB (the alternative — conditional-write
 * retry loops — exists for cases that need more than a plain increment,
 * which this doesn't).
 *
 * A SKU is only ever consumed by the createInventory Server Action
 * immediately writing it onto a new Inventory record, so "once issued,
 * never reused" (spec §6) holds even if that particular registration is
 * later abandoned mid-form — the counter never goes backwards.
 */
export const handler = async (): Promise<string> => {
  const tableName = process.env.SKU_COUNTER_TABLE_NAME;
  if (!tableName) {
    throw new Error("SKU_COUNTER_TABLE_NAME is not set.");
  }

  const result = await client.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { id: { S: COUNTER_PARTITION_KEY } },
      UpdateExpression: "ADD counterValue :incr",
      ExpressionAttributeValues: { ":incr": { N: "1" } },
      ReturnValues: "UPDATED_NEW",
    }),
  );

  const nextValue = Number(result.Attributes?.counterValue?.N ?? "0");
  return `${SKU_PREFIX}${String(nextValue).padStart(SKU_DIGITS, "0")}`;
};
