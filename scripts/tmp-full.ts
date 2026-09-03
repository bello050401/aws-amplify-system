import { runWithDirectData, serverDataClient as c } from "@/lib/amplify/dataClient";
import { processInquiryAndNotifyUnauthenticated } from "@/lib/inquiry/autoReply";
import { buildNotificationMessages } from "@/lib/messaging/lineNotify/format";
import { decideReview } from "@/lib/messaging/lineNotify/reviewPolicy";

const CONV = "cecc2d1d-15d9-4b0c-8e3d-058964bc89e0";
const MSG = "4ff3e469-9ead-4a68-ae1e-2444c5a85354";

async function main() {
  const r = await processInquiryAndNotifyUnauthenticated({ conversationId: CONV, sourceMessageId: MSG, who: null });
  await runWithDirectData(async () => {
    const { data: drafts } = await c.models.ReplyDraft.list({ limit: 300 });
    const mine = ((drafts ?? []) as any[])
      .filter((d) => d.sourceMessageId === MSG)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const d = mine[0];
    const ev = typeof d.sourceSummary === "string" ? JSON.parse(d.sourceSummary) : d.sourceSummary;
    console.log("状態:", d.status, "/ 特定在庫:", d.resolvedInventoryId ?? "(無)");
    console.log("BASE状態:", ev.baseProductStatus, "/ 在庫状態:", ev.productStatus, "/ 同期疑い:", ev.inventorySyncSuspected);
    console.log("送料:", JSON.stringify(ev.shipping));
    const review = decideReview({
      draftStatus: d.status,
      evidence: ev,
      deliveryWindowState: null,
      generationFailed: false,
    });
    const msgs = buildNotificationMessages({
      channel: "LINE",
      customerName: "大原毅士",
      messageText: "https://bellointeri.base.shop/items/156144635\n\nこちら3万円になりませんか",
      intents: typeof d.intents === "string" ? JSON.parse(d.intents) : (d.intents ?? []),
      evidence: ev,
      draftText: d.draftText ?? null,
      needsHumanReview: review.needsHumanReview,
      reviewReasons: review.reasons,
      logId: null,
      failureReason: null,
      productContextNotes: ev.productContextNotes ?? [],
    } as never);
    console.log("\n========== 1通目 ==========\n" + msgs.summary);
    console.log("\n========== 2通目 ==========\n" + (msgs.reply ?? "(なし)"));
  });
  console.log("\n通知:", JSON.stringify((r as any).notify ?? null));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
