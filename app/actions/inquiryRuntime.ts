"use server";
import {
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { directTableName } from "@/lib/amplify/directData";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getInventoryRole, getCurrentInventoryUserSub } from "@/lib/amplify/requireInventoryUser";
import { getConversation, listMessages } from "@/lib/messaging/service";
import { listReplyDrafts } from "@/lib/inquiry/draftStore";
import { createAttachmentViewUrl } from "@/lib/messaging/attachmentStore";
import { getInventoryDetail } from "@/lib/inventory/queries";
import {readJobKey} from '@/lib/inquiry/runtime/readContract';
import {CUSTOMER_DELIVERY_ENABLED} from '@/lib/messaging/featureState';
import {enqueueCustomerDelivery} from '@/lib/inquiry/runtime/deliveryJobs';
import {retryInquiryRead,type InquiryReadJob} from '@/lib/inquiry/runtime/readJobs';
import {
  inquiryDb,
  runtimeConfig,
  inquirySettings,
  stateFor,
  getRuntimeRecord,
} from "@/lib/inquiry/runtime/store";
async function requireAccess(admin = false) {
  const role = await getInventoryRole();
  if (role !== "ADMIN" && (admin || role !== "EDITOR"))
    throw Error("操作権限がありません。");
}
export async function readInquiryQueue(cursor?: string) {
  await requireAccess();
  let start: Record<string, unknown> | undefined;
  if (cursor) {
    try {
      if (cursor.length > 1024) throw Error();
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (!/^CONV#[a-f0-9]{64}$/.test(value.pk) || value.sk !== "STATE" || value.kind !== "INBOX" || !Number.isFinite(value.lastAt)) throw Error();
      start = {pk:value.pk,sk:"STATE",kind:"INBOX",lastAt:value.lastAt};
    } catch { throw Error("一覧を読み込み直してください。"); }
  }
  const c = runtimeConfig();
  const [settings, result] = await Promise.all([
    inquirySettings(),
    inquiryDb.send(
      new QueryCommand({
        TableName: c.table,
        IndexName: "recent",
        KeyConditionExpression: "kind=:kind",
        ExpressionAttributeValues: { ":kind": "INBOX" },
        ScanIndexForward: false,
        Limit: 50,
        ExclusiveStartKey: start,
      }),
    ),
  ]);
  return {
    cursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url") : null,
    settings: {
      enabled: !!settings.enabled,
      notifyStaff: !!settings.notifyStaff,
      deliveryEnabled:CUSTOMER_DELIVERY_ENABLED&&['REVIEW','AUTO'].includes(settings.delivery?.mode),
      automaticDelivery:CUSTOMER_DELIVERY_ENABLED&&settings.delivery?.mode==='AUTO',
    },
    items: (result.Items ?? []).map((r) => ({
      pk: String(r.pk),
      channel: String(r.channel),
      lastAt: Number(r.lastAt),
      result: String(r.result),
      reason: String(r.reason ?? ""),
      mode: String(r.mode ?? "DRAFT"),
      conversationId:
        typeof r.conversationId === "string" ? r.conversationId : null,
    })),
  };
}
export async function readInquiryDetail(pk: string) {
  await requireAccess();
  if (!/^CONV#[a-f0-9]{64}$/.test(pk)) throw Error("対象を確認できません。");
  const state = await stateFor(pk);
  if (!state?.conversationId) return null;
  const [conversation, messages, drafts] = await Promise.all([
    getConversation(state.conversationId),
    listMessages(state.conversationId),
    listReplyDrafts(state.conversationId),
  ]);
  if (!conversation) return null;
  const attachments = await Promise.all(
    messages
      .filter((m) => m.attachmentStatus === "STORED" && m.attachmentStorageKey)
      .map(async (m) => ({
        id: m.id,
        url: await createAttachmentViewUrl(m.attachmentStorageKey!),
      })),
  );
  const latest = messages
    .filter((m) => m.direction === "INBOUND" && m.body !== "[送信取消]")
    .sort((a, b) =>
      (b.externalSentAt ?? b.createdAt).localeCompare(
        a.externalSentAt ?? a.createdAt,
      ),
    )[0];
  const currentDrafts =
    state.version > (state.processedVersion ?? 0)
      ? []
      : drafts.filter((d) => d.sourceMessageId === latest?.id);
  const productIds = [...new Set(currentDrafts.flatMap(d=>d.evidence?.productCandidates.map(p=>p.inventoryId)??[]))].slice(0, 10);
  const products = await Promise.all(productIds.map(async id=>{
    const p = await getInventoryDetail(id);
    return p ? {id, storageKey:p.mainImageThumbnailKey??p.mainImageStorageKey, quantity:p.quantity, sku:p.sku} : null;
  }));
  const event=state.sourceEventSk?await getRuntimeRecord(pk,state.sourceEventSk):null;
  const sourceId=event?.payload?.params?.sourceMessageId;
  const readJob=sourceId?await getRuntimeRecord(readJobKey(pk,state.version,sourceId)) as InquiryReadJob|undefined:null;
  const delivery=state.lastDeliveryJobId?await getRuntimeRecord(state.lastDeliveryJobId):null;
  return {
    conversation,
    messages,
    drafts: currentDrafts,
    attachments,
    products: products.filter(p=>p!==null),
    remoteRead:readJob?{status:readJob.status,snapshot:readJob.status==='DONE'?readJob.result:null}:null,
    version: state.version,
    delivery:delivery?{status:String(delivery.status),acceptedAt:typeof delivery.acceptedAt==='string'?delivery.acceptedAt:null}:null,
  };
}
export async function sendInquiryDraftAction(pk:string,draftId:string,version:string){
  await requireAccess(true);
  if(!/^CONV#[a-f0-9]{64}$/.test(pk)||typeof draftId!=='string'||draftId.length>200||typeof version!=='string'||version.length>60)throw Error('対象を確認できません。');
  const actor=await getCurrentInventoryUserSub();if(!actor)throw Error('ログインし直してください。');
  try{return await enqueueCustomerDelivery(pk,draftId,version,actor,true);}
  catch{throw Error('送信を予約できませんでした。最新の会話・返信案と送信の有効化状況を確認してください。');}
}
export async function retryInquiryReadAction(pk:string){
  await requireAccess(true);
  if(!/^CONV#[a-f0-9]{64}$/.test(pk))throw Error('対象を確認できません。');
  await retryInquiryRead(pk);
}
export async function refreshInquiryPhoto(pk: string, messageId: string) {
  await requireAccess();
  if (!/^CONV#[a-f0-9]{64}$/.test(pk)) throw Error("対象を確認できません。");
  const state = await stateFor(pk);
  if (!state?.conversationId) throw Error("問い合わせが見つかりません。");
  const message = (await listMessages(state.conversationId)).find(m=>m.id===messageId);
  if (!message || message.body === "[送信取消]" || message.attachmentStatus !== "STORED" || !message.attachmentStorageKey) throw Error("写真は削除されたか、表示できなくなりました。");
  return createAttachmentViewUrl(message.attachmentStorageKey);
}
export async function setInquiryMode(pk: string, mode: "STAFF" | "DRAFT") {
  await requireAccess();
  if (!/^CONV#[a-f0-9]{64}$/.test(pk) || !["STAFF", "DRAFT"].includes(mode))
    throw Error("操作を確認できません。");
  const c = runtimeConfig();
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await stateFor(pk);
    if (!state) throw Error("問い合わせが見つかりません。");
    const last =
      mode === "DRAFT" && (state.sourceEventSk || state.lastEventSk)
        ? await getRuntimeRecord(pk, state.sourceEventSk || state.lastEventSk!)
        : null;
    const previous = last
      ? Math.min(
          state.processedVersion ?? 0,
          Math.max(0, Number(last.version) - 1),
        )
      : (state.processedVersion ?? 0);
    try {
      await inquiryDb.send(
        new UpdateCommand({
          TableName: c.table,
          Key: { pk, sk: "STATE" },
          ConditionExpression: "#v=:v",
          UpdateExpression:
            "SET #mode=:mode, processedVersion=:previous,dueAt=:due REMOVE lockOwner,lockUntil",
          ExpressionAttributeNames: { "#mode": "mode", "#v": "version" },
          ExpressionAttributeValues: {
            ":v": state.version,
            ":mode": mode,
            ":previous": previous,
            ":due": Date.now(),
          },
        }),
      );
      break;
    } catch (e) {
      if (
        (e as Error).name !== "ConditionalCheckFailedException" ||
        attempt === 3
      )
        throw e;
    }
  }
  if (mode === "DRAFT")
    await new SQSClient({ region: c.region }).send(
      new SendMessageCommand({
        QueueUrl: c.queueUrl,
        MessageBody: JSON.stringify({ pk }),
      }),
    );
}
export async function pollInquiryMailAction() {
  await requireAccess(true);
  const c = runtimeConfig();
  await new SQSClient({ region: c.region }).send(
    new SendMessageCommand({
      QueueUrl: c.queueUrl,
      MessageBody: JSON.stringify({ action: "POLL" }),
    }),
  );
  return { queued: true };
}

export async function setInquiryProcessing(enabled: boolean) {
  await requireAccess(true);
  if (typeof enabled !== "boolean") throw Error("設定を確認してください。");
  const c = runtimeConfig();
  await inquiryDb.send(
    new UpdateCommand({
      TableName: c.table,
      Key: { pk: "CONFIG", sk: "STATE" },
      UpdateExpression:
        "SET enabled=:enabled,notifyStaff=if_not_exists(notifyStaff,:off)",
      ExpressionAttributeValues: { ":enabled": enabled, ":off": false },
    }),
  );
  // Scheduling is private and paginated; a paused website session cannot interrupt resumption.
  if (enabled)
    await new SQSClient({ region: c.region }).send(
      new SendMessageCommand({
        QueueUrl: c.queueUrl,
        MessageBody: JSON.stringify({ action: "RESUME" }),
      }),
    );
}
export async function editInquiryDraft(
  pk: string,
  draftId: string,
  updatedAt: string,
  body: string,
) {
  await requireAccess();
  if (!/^CONV#[a-f0-9]{64}$/.test(pk) || !body.trim() || body.length > 10000)
    throw Error("返信案の内容を確認してください。");
  const actor = await getCurrentInventoryUserSub();
  if (!actor) throw Error("ログインし直してください。");
  const state = await stateFor(pk),
    detail = await readInquiryDetail(pk);
  const draft = detail?.drafts.find(
    (d) =>
      d.id === draftId && d.updatedAt === updatedAt && d.status !== "DISMISSED",
  );
  if (!state || !draft)
    throw Error("問い合わせが更新されました。読み込み直して確認してください。");
  await inquiryDb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: runtimeConfig().table,
            Key: { pk, sk: "STATE" },
            ConditionExpression: "#v=:v AND processedVersion=:v",
            UpdateExpression: "SET #mode=:staff REMOVE lockOwner,lockUntil",
            ExpressionAttributeNames: { "#v": "version", "#mode": "mode" },
            ExpressionAttributeValues: {
              ":v": state.version,
              ":staff": "STAFF",
            },
          },
        },
        {
          Update: {
            TableName: directTableName("ReplyDraft"),
            Key: { id: draft.id },
            ConditionExpression: "updatedAt=:old AND conversationId=:cid",
            UpdateExpression:
              "SET draftText=:body,updatedAt=:now,updatedBy=:who",
            ExpressionAttributeValues: {
              ":old": updatedAt,
              ":cid": state.conversationId,
              ":body": body.trim(),
              ":now": new Date().toISOString(),
              ":who": actor,
            },
          },
        },
      ],
    }),
  );
}

export async function chooseInquiryProduct(
  pk: string,
  inventoryId: string,
  expectedVersion: number,
) {
  await requireAccess();
  const detail = await readInquiryDetail(pk),
    state = await stateFor(pk);
  if (
    !state ||
    detail?.version !== state.version ||
    state.version !== expectedVersion ||
    !detail?.drafts.some((d) =>
      d.evidence?.productCandidates.some((p) => p.inventoryId === inventoryId),
    )
  )
    throw Error("最新の商品候補を選んでください。");
  await inquiryDb.send(
    new UpdateCommand({
      TableName: runtimeConfig().table,
      Key: { pk, sk: "STATE" },
      ConditionExpression: "#v=:v",
      UpdateExpression: "SET overrideInventoryId=:id,overrideVersion=:v",
      ExpressionAttributeNames: { "#v": "version" },
      ExpressionAttributeValues: { ":id": inventoryId, ":v": state.version },
    }),
  );
  await setInquiryMode(pk, "DRAFT");
}
