import "server-only";
import { parseLineWebhookBody } from "@/lib/messaging/line/adapter";
import { fetchLineProfile } from "@/lib/messaging/line/profile";
import { fetchLineMessageContent } from "@/lib/messaging/line/content";
import { saveIncomingAttachment } from "@/lib/messaging/attachmentStore";
import {
  recordIncomingWebhookMessage,
} from "@/lib/messaging/webhookStore";
import { isWithdrawn, removeWithdrawnContent } from "./withdrawn";
import { scopeKey } from "./policy";
import type { LineWebhookEvent } from "@/lib/messaging/line/types";

export async function receiveLine(account: string, event: LineWebhookEvent) {
  const customer = event.source?.userId;
  if (event.source?.type !== "user" || !customer) return null;
  const conversationKey = scopeKey("LINE", account, customer);
  if (event.type === "unsend" && event.unsend?.messageId) {
    await removeWithdrawnContent(
      conversationKey,
      account,
      event.unsend.messageId,
    );
    return null;
  }
  const msg = parseLineWebhookBody({
    destination: account,
    events: [event],
  })[0];
  if (!msg) return null;
  if (await isWithdrawn(conversationKey, msg.externalMessageId)) return null;
  const externalMessageId = "line:" + account + ":" + msg.externalMessageId;
  const profile = await fetchLineProfile(customer);
  let attachment: {
    attachmentStorageKey?: string;
    attachmentContentType?: string;
    attachmentSizeBytes?: number;
    attachmentStatus: "NONE" | "STORED" | "FAILED";
    attachmentError?: string;
  } = { attachmentStatus: "NONE" };
  if (msg.hasDownloadableContent) {
    const content = await fetchLineMessageContent(msg.externalMessageId);
    if (content.ok) {
      const saved = await saveIncomingAttachment({
        conversationId: conversationKey,
        externalMessageId,
        body: content.body,
        contentType: content.contentType,
      });
      attachment = saved.ok
        ? {
            attachmentStorageKey: saved.storageKey,
            attachmentContentType: saved.contentType,
            attachmentSizeBytes: saved.sizeBytes,
            attachmentStatus: "STORED",
          }
        : {
            attachmentStatus: "FAILED",
            attachmentError:
              "添付画像を保存できませんでした。再取得してください。",
          };
    } else
      attachment = {
        attachmentStatus: "FAILED",
        attachmentError: "添付画像を取得できませんでした。再取得してください。",
      };
  }
  return recordIncomingWebhookMessage({
    channel: "LINE",
    externalCustomerId: customer,
    externalConversationId: conversationKey,
    externalAccountId: account,
    externalMessageId,
    body: msg.body,
    externalSentAt: msg.externalSentAt,
    quotedMessageId: event.message?.quotedMessageId ?? null,
    customerDisplayName: profile.ok ? profile.profile.displayName : null,
    customerNameSource: profile.ok ? "LINE_PROFILE" : "LINE_PROFILE_FAILED",
    customerNameFetchedAt: new Date().toISOString(),
    contentKind: msg.contentKind,
    ...attachment,
  });
}
