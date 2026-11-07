import "server-only";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { inquiryDb, runtimeConfig } from "./store";
import { markWithdrawn } from "./withdrawalState";
export { isWithdrawn, markWithdrawn } from "./withdrawalState";
import {
  runWithDirectData,
  serverDataClient,
  inventoryAuthMode,
} from "@/lib/amplify/dataClient";
import { deterministicMessageId } from "@/lib/messaging/webhookStore";
import { purgeIncomingAttachment } from "@/lib/messaging/attachmentStore";
import { listReplyDrafts } from "@/lib/inquiry/draftStore";
import { saveConversationContext } from "@/lib/inquiry/contextStore";
import { emptyConversationContext } from "@/lib/inquiry/conversationContext";
import { listAllPages } from "@/lib/amplify/listAll";
export async function removeWithdrawnContent(
  pk: string,
  account: string,
  externalId: string,
) {
  await markWithdrawn(pk, externalId);
  const id = deterministicMessageId("line:" + account + ":" + externalId);
  await runWithDirectData(async () => {
    const { data, errors } = await serverDataClient.models.Message.get(
      { id },
      inventoryAuthMode,
    );
    if (errors) throw Error("UNSEND_READ_FAILED");
    if (data) {
      if (data.attachmentStorageKey)
        await purgeIncomingAttachment(data.attachmentStorageKey);
      const update = await serverDataClient.models.Message.update(
        {
          id,
          body: "[送信取消]",
          contentKind: "OTHER",
          attachmentStatus: "NONE",
          attachmentStorageKey: null,
          attachmentContentType: null,
          attachmentSizeBytes: null,
        },
        inventoryAuthMode,
      );
      if (update.errors) throw Error("UNSEND_UPDATE_FAILED");
      const drafts = await listReplyDrafts(data.conversationId);
      for (const d of drafts) {
        const result = await serverDataClient.models.ReplyDraft.update(
          {
            id: d.id,
            status: "DISMISSED",
            draftText: null,
            sourceSummary: null,
            unresolvedFacts: null,
            failureReason:
              "会話内のメッセージが取り消されたため、返信案を破棄しました。",
          },
          inventoryAuthMode,
        );
        if (result.errors) throw Error("UNSEND_DRAFT_FAILED");
      }
      const deliveries = await listAllPages(
        (nextToken) =>
          serverDataClient.models.NotificationDelivery.list({
            filter: { conversationId: { eq: data.conversationId } },
            limit: 100,
            nextToken,
            ...inventoryAuthMode,
          }),
        { label: "通知" },
      );
      for (const delivery of deliveries) {
        const result =
          await serverDataClient.models.NotificationDelivery.update(
            {
              id: delivery.id,
              status: "SUPERSEDED",
              summaryText: null,
              replyText: null,
              errorMessage:
                "送信取消により保管していた通知本文を破棄しました。",
            },
            inventoryAuthMode,
          );
        if (result.errors) throw Error("UNSEND_NOTIFICATION_FAILED");
      }
      const context = await saveConversationContext(data.conversationId, () =>
        emptyConversationContext(),
      );
      if (!context.saved) throw Error("UNSEND_CONTEXT_FAILED");
      const conv = await serverDataClient.models.Conversation.update(
        { id: data.conversationId, lastMessagePreview: "メッセージの送信取消" },
        inventoryAuthMode,
      );
      if (conv.errors) throw Error("UNSEND_CONVERSATION_FAILED");
    }
  });
  let key: Record<string, unknown> | undefined;
  do {
    const p = await inquiryDb.send(
      new QueryCommand({
        TableName: runtimeConfig().table,
        KeyConditionExpression: "pk=:pk AND begins_with(sk,:event)",
        ExpressionAttributeValues: { ":pk": pk, ":event": "EVENT#" },
        ExclusiveStartKey: key,
        ConsistentRead: true,
      }),
    );
    for (const row of p.Items ?? [])
      if (
        row.payload?.channel === "LINE" &&
        row.payload.event?.message?.id === externalId
      ) {
        const payload = {
          channel: "LINE",
          account,
          event: {
            type: "unsend",
            timestamp: row.payload.event.timestamp,
            source: row.payload.event.source,
            unsend: { messageId: externalId },
          },
        };
        await inquiryDb.send(
          new UpdateCommand({
            TableName: runtimeConfig().table,
            Key: { pk, sk: row.sk },
            UpdateExpression: "SET payload=:payload",
            ExpressionAttributeValues: { ":payload": payload },
          }),
        );
      }
    key = p.LastEvaluatedKey;
  } while (key);
}
