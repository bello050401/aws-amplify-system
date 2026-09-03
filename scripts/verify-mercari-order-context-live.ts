/**
 * 2026-09-04 追加指示 §57/§68: 実データでの確認。
 *
 *   AWS_PROFILE=Bello npm run verify:mercari-order-live -- [--reprocess] [--gmail <id> ...]
 *
 * 既定は**読み取りのみ**。各取引メッセージについて
 *
 *   ・inquiryId / orderId
 *   ・現在の商品特定結果(会話Contextに保存されている値)
 *   ・同一orderIdの既存メール件数
 *   ・そこから取得できる商品名
 *   ・Inventory照合 / BASE照合
 *   ・社内通知の「対象商品」欄がどう出るか
 *
 * を並べる。`--reprocess` を付けたときだけ、既存の会話・メッセージを
 * そのまま使って処理をやり直す(会話もメッセージも新規に作らない)。
 *
 * ── 通知を勝手に再送しない ──────────────────────────────────────
 *
 * §68。やり直しは notifyInquiry を通るが、既に SENT の通知は
 * dedupeKey の判定で送信されない(lib/messaging/lineNotify/service.ts の
 * canSend)。文面だけが最新の処理結果へ差し替わる。
 */
import { ensureConversationTableName } from "./lib/resolveStagingTables";

/** 既定の調査対象。2026-09-03 に新着として取り込まれた取引メッセージ3件。 */
const DEFAULT_GMAIL_IDS = ["1a066b29d3ea7441", "1a066dbcf343566c", "1a066e472c5fc35c"];

async function main() {
  const args = process.argv.slice(2);
  const reprocess = args.includes("--reprocess");
  const explicit: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--gmail" && args[i + 1]) explicit.push(args[++i]);
  const gmailIds = explicit.length > 0 ? explicit : DEFAULT_GMAIL_IDS;

  await ensureConversationTableName();

  const { runWithDirectData } = await import("@/lib/amplify/dataClient");
  const { fetchMercariNotificationMailsByIds, searchMercariMails } = await import(
    "@/lib/messaging/email/gmailClient"
  );
  const { canonicalOrderId, parseMercariNotificationMail, conversationKeyFor } = await import(
    "@/lib/messaging/mercari/notificationMailParser"
  );
  const { restoreOrderProduct } = await import("@/lib/messaging/mercari/orderProductContext");
  const { getMercariOrderContext } = await import("@/lib/messaging/mercari/orderContextStore");
  const { resolveProductFromInquiry } = await import("@/lib/inquiry/productResolver");
  const { findMessageByExternalId } = await import("@/lib/messaging/webhookStore");
  const { loadConversationContext } = await import("@/lib/inquiry/contextStore");
  const { buildSummaryMessage } = await import("@/lib/messaging/lineNotify/format");

  console.log(`[verify-mercari-order-live] 開始 ${new Date().toISOString()}`);
  console.log(`  対象 ${gmailIds.length}件${reprocess ? "  (--reprocess: 既存の会話・メッセージで処理をやり直します)" : "  (読み取りのみ)"}`);

  const mails = await fetchMercariNotificationMailsByIds(gmailIds);
  for (const mail of mails) {
    const parsed = parseMercariNotificationMail(mail);
    const orderId = canonicalOrderId(parsed.order.orderNumber);

    console.log("\n════════════════════════════════════════════════════");
    console.log(`Gmail ID     : ${mail.gmailId}`);
    console.log(`受信         : ${mail.receivedAt}`);
    console.log(`種別         : ${parsed.kind ?? "-"} (${parsed.status})`);
    console.log(`inquiryId    : ${parsed.inquiryId ?? "-"}`);
    console.log(`orderId      : ${orderId ?? "-"}`);
    console.log(`メールの商品名: ${parsed.productName ?? "(無し)"}`);
    console.log(`顧客本文     : ${(parsed.messageText ?? "").replace(/\n/g, " / ").slice(0, 80)}`);

    // ── 現在の商品特定結果(保存されている会話Context) ──────
    const link = await findMessageByExternalId(`gmail:${mail.gmailId}`);
    let beforeProduct = "(会話が見つかりません)";
    if (link?.conversationId) {
      const loaded = await loadConversationContext(link.conversationId);
      const p = loaded.context.identifiedProduct;
      beforeProduct = `inventoryStatus=${p.inventoryStatus} baseStatus=${p.baseStatus} 在庫=${p.displayInventoryId ?? "-"} 商品名=${p.inventoryName ?? p.baseProductName ?? p.channelProductName ?? "(無し)"}`;
    }
    console.log(`処理前の特定 : ${beforeProduct}`);

    if (!orderId) {
      console.log("注文番号が無いため、注文Contextの確認は行いません。");
      continue;
    }

    // ── 同一orderIdの既存メール件数(§57) ────────────────────
    let sameOrderMails = 0;
    let productFromPastMail: string | null = null;
    try {
      const found = await searchMercariMails(`"${orderId}" from:no-reply@mercari-shops.com`, 20);
      sameOrderMails = found.length;
      for (const m of found) {
        const p = parseMercariNotificationMail(m);
        if (canonicalOrderId(p.order.orderNumber) !== orderId) continue;
        if (p.productName && !productFromPastMail) productFromPastMail = p.productName;
      }
    } catch (err) {
      console.log(`  (Gmail検索に失敗: ${err instanceof Error ? err.message : String(err)})`);
    }
    console.log(`同一orderIdの既存メール: ${sameOrderMails}件`);
    console.log(`過去メールの商品名     : ${productFromPastMail ?? "(取得できず)"}`);

    // ── 保存済みの対応表(§51/§65 主経路) ────────────────────
    const record = await getMercariOrderContext(orderId);
    console.log(
      `注文Context  : ${
        record
          ? `商品名=${record.productName ?? "-"} 在庫=${record.displayInventoryId ?? "-"}(${record.inventoryStatus}) 出所=${record.evidenceSource ?? "-"} 購入通知=${record.purchaseNotificationSeen ? "あり" : "無し"}`
          : "(未登録)"
      }`,
    );

    const restored = await restoreOrderProduct({
      orderId,
      inquiryId: parsed.inquiryId,
      mailProductName: parsed.productName,
    });
    console.log(`復元した商品名: ${restored.productName ?? "(復元できず)"}  経路=${restored.source}`);
    for (const n of restored.notes) console.log(`  - ${n}`);

    // ── Inventory / BASE 照合(購入済み注文として) ────────────
    if (restored.productName) {
      const resolution = await runWithDirectData(() =>
        resolveProductFromInquiry({
          messageText: restored.productName as string,
          productTitle: restored.productName,
          purchasedOrder: true,
        }),
      );
      console.log(
        `Inventory照合: ${resolution.status} 在庫=${resolution.resolved?.displayInventoryId ?? "-"} 候補=${resolution.candidates
          .map((c) => `${c.displayInventoryId}(${c.confidence.toFixed(2)})`)
          .join(" ")}`,
      );
      if (resolution.resolved) console.log(`  在庫名: ${resolution.resolved.name}`);
      console.log(
        `BASE照合     : ${resolution.baseProducts.length > 0 ? resolution.baseProducts.map((b) => b.baseItemId).join(" ") : "該当なし(メールに商品URLが無いため手がかり無し)"}`,
      );

      // ── 社内通知の「対象商品」欄がどう出るか(§58) ──────────
      //
      // 在庫まで特定できたときは通常の商品カード、できなかったときは
      // 「販売チャネルの商品：特定できました」の分岐になる。ここでは
      // 照合結果をそのまま渡して、実際に出る文面を確かめる。
      const summary = buildSummaryMessage({
        channel: "MERCARI_SHOPS",
        customerName: null,
        messageText: parsed.messageText ?? "",
        intents: [],
        evidence: {
          product: null,
          productStatus: resolution.status,
          productCandidates: resolution.candidates,
          inventoryFieldsUsed: [],
          knowledgeDocuments: [],
          shipping: null,
          externalResearchAttempted: false,
          externalFacts: [],
          unresolvedFacts: [],
          baseProducts: [],
          identifiedProduct: null,
          channelProduct: {
            productName: restored.productName,
            orderId,
            itemAmountYen: parsed.order.itemAmountYen,
            shippingFeeYen: parsed.order.shippingFeeYen,
            couponDiscountYen: parsed.order.couponDiscountYen,
            totalAmountYen: parsed.order.totalAmountYen,
          },
        },
        draftText: null,
        needsHumanReview: false,
        reviewReasons: [],
        logId: null,
        failureReason: null,
        inquiryKind: "ORDER_MESSAGE",
        orderNumber: orderId,
        orderProduct: { productName: restored.productName, orderId },
      });
      const section = summary.split("\n\n").find((s) => s.startsWith("■ 対象商品")) ?? "(見つかりません)";
      console.log("社内通知の「対象商品」欄(在庫カード無しの場合の見え方):");
      for (const line of section.split("\n")) console.log(`  ${line}`);
    }

    // ── やり直し(§57) ────────────────────────────────────────
    if (reprocess) {
      if (!link?.conversationId || !link?.messageId) {
        console.log("やり直し: このメールに対応する会話・メッセージがまだありません(通常の取り込みを先に実行してください)。");
        continue;
      }
      const { processInquiryAndNotifyUnauthenticated } = await import("@/lib/inquiry/autoReply");
      const productName = restored.productName ?? parsed.productName;
      const result = await processInquiryAndNotifyUnauthenticated({
        conversationId: link.conversationId,
        sourceMessageId: link.messageId,
        who: "verify-mercari-order-live",
        productLookupHint: productName,
        productTitle: productName,
        inquiryKind: "ORDER_MESSAGE",
        orderNumber: orderId,
        additionalContext: [
          "このお問い合わせは、**購入済みの注文**に対する取引メッセージです。購入前の商品問い合わせとして扱わないでください。",
          `注文番号: ${orderId}`,
          productName ? `商品名: ${productName}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        order: {
          orderId,
          productName,
          itemAmountYen: parsed.order.itemAmountYen,
          shippingFeeYen: parsed.order.shippingFeeYen,
          couponDiscountYen: parsed.order.couponDiscountYen,
          totalAmountYen: parsed.order.totalAmountYen,
          inventoryId: record?.inventoryId ?? null,
          baseItemId: record?.baseItemId ?? null,
          baseUrl: record?.baseUrl ?? null,
        },
        productContextNotes: restored.notes,
      });
      console.log(`やり直し     : 返信案=${result.drafted ? "生成" : "無し"} 通知=${result.notify?.status ?? "-"} (${result.reason})`);

      const after = await loadConversationContext(link.conversationId);
      const p = after.context.identifiedProduct;
      console.log(
        `処理後の特定 : inventoryStatus=${p.inventoryStatus} 在庫=${p.displayInventoryId ?? "-"} 商品名=${p.inventoryName ?? p.channelProductName ?? "(無し)"} 注文番号=${after.context.order.orderId ?? "-"}`,
      );

      // 実際に社内通知として記録された文面(送信はしていない)。§58 の確認。
      const { buildDedupeKey } = await import("@/lib/messaging/lineNotify/deliveryPolicy");
      const { findDeliveryByDedupeKey } = await import("@/lib/messaging/lineNotify/deliveryStore");
      const delivery = await runWithDirectData(() =>
        findDeliveryByDedupeKey(
          buildDedupeKey({
            channel: "MERCARI_SHOPS",
            conversationId: link.conversationId as string,
            sourceMessageId: link.messageId as string,
          }),
        ),
      );
      if (delivery?.summaryText) {
        const section = delivery.summaryText.split("\n\n").find((s) => s.startsWith("■ 対象商品"));
        // 既に SENT の通知は文面を差し替えない(§68 勝手に再送しない、の
        // 裏返しで「送った文面を書き換えない」)。ここに出るのは**当時の**文面。
        console.log(`通知レコード : status=${delivery.status}(再送していません。文面も当時のまま)`);
        console.log("送信済み通知の「対象商品」欄(当時):");
        for (const line of (section ?? "(見つかりません)").split("\n")) console.log(`  ${line}`);
      }

      // ── 今この処理結果で通知を作ったらどうなるか(§58 の実測) ──
      //
      // 送信済みの文面は書き換えないので、**やり直しで得た本物の evidence**
      // から組み立てて確かめる。autoReply が notifyInquiry へ渡すのと同じ値。
      const { listReplyDrafts } = await import("@/lib/inquiry/draftStore");
      const drafts = await runWithDirectData(() => listReplyDrafts(link.conversationId as string));
      const latest = drafts.find((d) => d.sourceMessageId === link.messageId) ?? drafts[0] ?? null;
      if (latest?.evidence) {
        const nowSummary = buildSummaryMessage({
          channel: "MERCARI_SHOPS",
          customerName: null,
          messageText: parsed.messageText ?? "",
          intents: latest.intents,
          evidence: latest.evidence,
          draftText: latest.draftText,
          needsHumanReview: false,
          reviewReasons: [],
          logId: null,
          failureReason: null,
          inquiryKind: "ORDER_MESSAGE",
          orderNumber: orderId,
          orderProduct: restored.productName ? { productName: restored.productName, orderId } : null,
        });
        const nowSection = nowSummary.split("\n\n").find((s) => s.startsWith("■ 対象商品"));
        console.log("いま通知を作った場合の「対象商品」欄:");
        for (const line of (nowSection ?? "(見つかりません)").split("\n")) console.log(`  ${line}`);
      }
    }
  }

  console.log("\n[verify-mercari-order-live] 完了");
}

void main().catch((err) => {
  console.error(`[verify-mercari-order-live] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
