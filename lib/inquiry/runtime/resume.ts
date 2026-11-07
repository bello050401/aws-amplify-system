import "server-only";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  SQSClient,
  SendMessageBatchCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { inquiryDb, inquirySettings, runtimeConfig } from "./store";

/** One page per private job. Website requests never wait for an inbox-wide restart. */
export async function resumePending(cursor?: Record<string, unknown>) {
  if (!(await inquirySettings()).enabled) return;
  const c = runtimeConfig(),
    sqs = new SQSClient({ region: c.region });
  const page = await inquiryDb.send(
    new QueryCommand({
      TableName: c.table,
      IndexName: "recent",
      KeyConditionExpression: "kind=:kind",
      ExpressionAttributeValues: { ":kind": "INBOX" },
      Limit: 50,
      ExclusiveStartKey: cursor,
    }),
  );
  const pending = (page.Items ?? []).filter(
    (r) => r.version > (r.processedVersion ?? 0),
  );
  for (let i = 0; i < pending.length; i += 10) {
    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: c.queueUrl,
        Entries: pending
          .slice(i, i + 10)
          .map((r, n) => ({
            Id: String(n),
            MessageBody: JSON.stringify({ pk: r.pk }),
          })),
      }),
    );
    if (result.Failed?.length) throw Error("INQUIRY_RESUME_INCOMPLETE");
  }
  if (page.LastEvaluatedKey)
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: c.queueUrl,
        MessageBody: JSON.stringify({
          action: "RESUME",
          cursor: page.LastEvaluatedKey,
        }),
      }),
    );
}
