import "server-only";
import { randomUUID } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { runWithDirectData } from "@/lib/amplify/dataClient";
import {
  readGmailDelta,
  type GmailDeltaCursor,
} from "@/lib/messaging/email/gmailClient";
import { ingestMercariNotificationMails } from "@/lib/messaging/mercari/mailIngest";
import {
  getRuntimeRecord,
  inquiryDb,
  inquirySettings,
  runtimeConfig,
} from "./store";
export async function pollInquiryMail() {
  if (!(await inquirySettings()).enabled) return { state: "PAUSED" };
  const pk = "MAILBOX",
    sk = "STATE",
    owner = randomUUID(),
    now = Date.now(),
    TableName = runtimeConfig().table;
  try {
    await inquiryDb.send(
      new UpdateCommand({
        TableName,
        Key: { pk, sk },
        UpdateExpression: "SET lockOwner=:owner,lockUntil=:until",
        ConditionExpression:
          "attribute_not_exists(lockUntil) OR lockUntil<:now",
        ExpressionAttributeValues: {
          ":owner": owner,
          ":until": now + 180000,
          ":now": now,
        },
      }),
    );
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException")
      return { state: "BUSY" };
    throw error;
  }
  try {
    const record = await getRuntimeRecord(pk);
    const page =
      (record?.pending as
        | {
            ids: string[];
            mailbox: string;
            next: GmailDeltaCursor;
            done: boolean;
          }
        | undefined) ?? (await readGmailDelta(record?.cursor ?? {}));
    const batch = page.ids.slice(0, 8);
    const result = await runWithDirectData(() =>
      ingestMercariNotificationMails({
        mailIds: batch,
        maxResults: 8,
        who: null,
        reprocess: true,
        deferDraft: true,
        mailbox: page.mailbox,
      }),
    );
    if (result.failed || result.remaining)
      throw Error("INQUIRY_MAIL_INCOMPLETE");
    const rest = page.ids.slice(batch.length);
    await inquiryDb.send(
      new UpdateCommand({
        TableName,
        Key: { pk, sk },
        ConditionExpression: "lockOwner=:owner",
        UpdateExpression: rest.length
          ? "SET pending=:pending,updatedAt=:now REMOVE lockOwner,lockUntil"
          : "SET #cursor=:cursor,updatedAt=:now REMOVE pending,lockOwner,lockUntil",
        ...(rest.length
          ? {}
          : { ExpressionAttributeNames: { "#cursor": "cursor" } }),
        ExpressionAttributeValues: {
          ":owner": owner,
          ":now": new Date().toISOString(),
          ...(rest.length
            ? { ":pending": { ...page, ids: rest } }
            : { ":cursor": page.next }),
        },
      }),
    );
    return {
      state: "OK",
      processed: batch.length,
      more: rest.length > 0 || !page.done,
    };
  } catch (error) {
    await inquiryDb
      .send(
        new UpdateCommand({
          TableName,
          Key: { pk, sk },
          ConditionExpression: "lockOwner=:owner",
          UpdateExpression: "REMOVE lockOwner,lockUntil",
          ExpressionAttributeValues: { ":owner": owner },
        }),
      )
      .catch(() => {});
    throw error;
  }
}
