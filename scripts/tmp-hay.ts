import { runWithDirectData, serverDataClient as c } from "@/lib/amplify/dataClient";
import { processInquiryAndNotifyUnauthenticated } from "@/lib/inquiry/autoReply";
const CONV = "cecc2d1d-15d9-4b0c-8e3d-058964bc89e0";
async function main() {
  let msgId = "";
  await runWithDirectData(async () => {
    const { data } = await c.models.Message.listMessageByConversationId({ conversationId: CONV }, { limit: 50 });
    const hay = ((data ?? []) as any[]).filter((m) => String(m.body ?? "").includes("155832757"))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    msgId = hay?.id ?? "";
    console.log("HAYメッセージ:", msgId, "/", String(hay?.body ?? "").replace(/\n/g, " ").slice(0, 60));
  });
  if (!msgId) return;
  await processInquiryAndNotifyUnauthenticated({ conversationId: CONV, sourceMessageId: msgId, who: null });
  await runWithDirectData(async () => {
    const { data: drafts } = await c.models.ReplyDraft.list({ limit: 300 });
    const d = ((drafts ?? []) as any[]).filter((x) => x.sourceMessageId === msgId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const ev = typeof d.sourceSummary === "string" ? JSON.parse(d.sourceSummary) : d.sourceSummary;
    console.log("状態:", d.status, "/ BASE状態:", ev.baseProductStatus, "/ 在庫状態:", ev.productStatus);
    console.log("送料:", JSON.stringify(ev.shipping));
    const card = ev.identifiedProduct;
    console.log("在庫内訳:", JSON.stringify(card?.stockRows ?? []), "計", card?.totalQuantity);
    console.log("行ごとに異なる項目:", JSON.stringify(card?.ambiguousAcrossRows ?? []));
    console.log("仕入:", card?.purchasePriceYen, "/ 販売開始:", card?.saleStartedAt, "/ 状態:", card?.statusName);
    console.log("\n返信案:\n" + (d.draftText ?? "(なし)"));
  });
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
