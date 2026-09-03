import "server-only";
import { runWithDirectData } from "@/lib/amplify/dataClient";
import { resolveProductFromInquiry } from "@/lib/inquiry/productResolver";
import { GmailError, searchMercariMails } from "@/lib/messaging/email/gmailClient";
import {
  canonicalOrderId,
  parseMercariNotificationMail,
  type MercariMailParseResult,
} from "./notificationMailParser";
import {
  getMercariOrderContext,
  upsertMercariOrderContext,
  type MercariOrderContextRecord,
  type OrderContextEvidenceSource,
  type OrderInventoryStatus,
} from "./orderContextStore";

/**
 * 2026-09-04 追加指示 §50/§52/§56/§64/§65: **注文番号から商品Contextを復元する。**
 *
 * ── 何が壊れていたか(実データ) ──────────────────────────────────
 *
 * メルカリShopsの取引メッセージ3通(order_2JW2rNd9i7WdFrivCjhfpw)は、
 * 社内通知がすべて「対象商品：特定できませんでした」だった。原因は
 * メールの情報不足ではなく、**探し方**:
 *
 *   ・購入された商品は「販売中」カテゴリから外れる(実測: 在庫 B005614 は
 *     「発送完了」)。商品名照合は販売中だけを見るので原理的に当たらない。
 *   ・注文番号は毎回メールに載っているのに、それを鍵にした対応表が無く、
 *     1通ごとにゼロから商品を探し直していた。
 *
 * ── 復元の優先順位(§65) ─────────────────────────────────────────
 *
 *   1. 会話Context               … pipeline 側が引き継ぐ(このファイルの外)
 *   2. 購入通知で作った対応表    … **通常ケースの主経路**
 *   3. 同じ inquiryId の過去情報 … 会話Contextに含まれる
 *   4. 同じ orderId の既存情報   … 対応表がそのもの
 *   5. 保存済みGmailデータ       … 取り込み時に対応表へ入っている
 *   6. Gmail API検索             … **無いときだけ**(§56)
 *
 * 問い合わせのたびにGmailを引く構造にはしない。ここが「保存済みを先に見て、
 * 無いときだけ外へ出る」の実装。
 */

/** 復元結果。何を根拠に商品名へ辿り着いたかを必ず添える。 */
export interface RestoredOrderProduct {
  orderId: string;
  /** メルカリShopsの出品タイトル。取れなければ null。 */
  productName: string | null;
  /** どこから商品名を得たか(通知と診断に出す)。 */
  source: "ORDER_MAIL" | "ORDER_CONTEXT" | "GMAIL_SEARCH" | "NONE";
  /** 復元の過程。社内通知の「商品情報の補完」へそのまま出せる日本語。 */
  notes: string[];
  /** 保存済みの対応(あれば)。在庫・BASEの特定結果を含む。 */
  record: MercariOrderContextRecord | null;
}

/** 商品名から在庫・BASEまで解決した結果。 */
export interface OrderProductResolution {
  inventoryId: string | null;
  displayInventoryId: string | null;
  inventoryName: string | null;
  inventoryCandidateIds: string[];
  inventoryStatus: OrderInventoryStatus;
  baseItemId: string | null;
  baseUrl: string | null;
  notes: string[];
}

/**
 * 注文番号から商品名を復元する。
 *
 * @param mailProductName 今回のメールに載っていた商品名(あれば)。
 *   **これがあるときはGmailを引かない** —— 既に手元にある。
 */
export async function restoreOrderProduct(params: {
  orderId: string;
  inquiryId?: string | null;
  mailProductName?: string | null;
  /** Gmail検索まで許すか。取り込みの通常経路では true、バックフィルでは false。 */
  allowGmailSearch?: boolean;
}): Promise<RestoredOrderProduct> {
  const orderId = canonicalOrderId(params.orderId);
  const notes: string[] = [];
  if (!orderId) {
    return { orderId: params.orderId, productName: params.mailProductName ?? null, source: "NONE", notes, record: null };
  }

  // ── 2/4/5 保存済みの対応表(主経路) ──────────────────────────
  const record = await getMercariOrderContext(orderId);

  // 今回のメールに商品名があるなら、それが最も新しい一次情報。
  if (params.mailProductName?.trim()) {
    if (record?.productName && record.productName !== params.mailProductName.trim()) {
      // 同じ注文で商品名が変わることは通常あり得ない。**黙って上書きしない** ——
      // 注文番号の取り違えを疑える形で残す。
      notes.push(
        `注文番号${orderId}に保存済みの商品名と、今回のメールの商品名が一致しません(保存済み:「${record.productName}」)。`,
      );
    }
    return { orderId, productName: params.mailProductName.trim(), source: "ORDER_MAIL", notes, record };
  }

  if (record?.productName) {
    notes.push(
      record.purchaseNotificationSeen
        ? `対象商品：注文番号${orderId}の購入通知から商品名を復元しました。`
        : `対象商品：注文番号${orderId}の過去メールから商品名を復元しました。`,
    );
    return { orderId, productName: record.productName, source: "ORDER_CONTEXT", notes, record };
  }

  // ── 6 Gmail検索(保存済みで復元できなかったときだけ) ─────────
  if (params.allowGmailSearch === false) {
    notes.push(`注文番号${orderId}に対応する商品情報が保存済みデータにありませんでした。`);
    return { orderId, productName: null, source: "NONE", notes, record };
  }

  try {
    // 送信元も条件へ入れる。注文番号の文字列だけだと、転送メールや
    // 社内のやり取りまで拾いうる。
    const mails = await searchMercariMails(`"${orderId}" from:no-reply@mercari-shops.com`, 10);
    for (const mail of mails) {
      const parsed = parseMercariNotificationMail(mail);
      if (canonicalOrderId(parsed.order.orderNumber) !== orderId) continue;
      if (!parsed.productName) continue;
      notes.push(`対象商品：Gmailを注文番号${orderId}で検索し、過去メールから商品名を復元しました。`);
      const saved = await upsertMercariOrderContext(orderId, {
        productName: parsed.productName,
        productPriceYen: parsed.productPriceYen,
        quantity: parsed.quantity,
        itemAmountYen: parsed.order.itemAmountYen,
        shippingFeeYen: parsed.order.shippingFeeYen,
        couponDiscountYen: parsed.order.couponDiscountYen,
        totalAmountYen: parsed.order.totalAmountYen,
        shopId: parsed.shopId,
        orderUrl: parsed.orderUrl,
        evidenceSource: parsed.kind === "PURCHASE_NOTIFICATION" ? "PURCHASE_NOTIFICATION" : "GMAIL_SEARCH",
        purchaseNotificationSeen: parsed.kind === "PURCHASE_NOTIFICATION",
        purchasedAt: parsed.kind === "PURCHASE_NOTIFICATION" ? mail.receivedAt : undefined,
        addInquiryIds: [parsed.inquiryId, params.inquiryId].filter((v): v is string => Boolean(v)),
        addSourceGmailIds: [mail.gmailId],
        addPurchaseMailGmailIds: parsed.kind === "PURCHASE_NOTIFICATION" ? [mail.gmailId] : [],
      });
      return { orderId, productName: parsed.productName, source: "GMAIL_SEARCH", notes, record: saved };
    }
    notes.push(`Gmailを注文番号${orderId}で検索しましたが、商品名の分かるメールは見つかりませんでした。`);
  } catch (err) {
    // Gmailへ届かなくても取り込み全体は止めない。何ができなかったかは残す。
    const message = err instanceof GmailError ? err.message : err instanceof Error ? err.message : String(err);
    notes.push(`注文番号${orderId}でのGmail検索に失敗しました: ${message}`);
  }

  return { orderId, productName: null, source: "NONE", notes, record };
}

/**
 * 商品名から在庫・BASEまで解決する(§64)。
 *
 * **購入済み注文として解決する。** 販売中カテゴリに限らず探し、採用条件は
 * 出品タイトルの一致に絞る(lib/inquiry/productResolver.ts)。
 *
 * 解決できなくても例外にしない —— 商品名と注文番号は分かっているので、
 * その分だけでも保存しておけば後日解決できる(§70 ケースH)。
 */
export async function resolveOrderProduct(productName: string): Promise<OrderProductResolution> {
  const empty: OrderProductResolution = {
    inventoryId: null,
    displayInventoryId: null,
    inventoryName: null,
    inventoryCandidateIds: [],
    inventoryStatus: "NONE",
    baseItemId: null,
    baseUrl: null,
    notes: [],
  };
  const title = productName.trim();
  if (!title) return empty;

  try {
    const resolution = await resolveProductFromInquiry({
      messageText: title,
      productTitle: title,
      purchasedOrder: true,
    });
    const base = resolution.baseProducts[0] ?? null;
    return {
      inventoryId: resolution.resolved?.inventoryId ?? null,
      displayInventoryId: resolution.resolved?.displayInventoryId ?? null,
      inventoryName: resolution.resolved?.name ?? null,
      inventoryCandidateIds: resolution.candidates.map((c) => c.inventoryId),
      inventoryStatus:
        resolution.status === "RESOLVED"
          ? "RESOLVED"
          : resolution.status === "AMBIGUOUS"
            ? "AMBIGUOUS"
            : "NOT_FOUND",
      baseItemId: base?.baseItemId ?? null,
      baseUrl: base?.itemUrl ?? null,
      notes:
        resolution.status === "RESOLVED"
          ? [`対象商品：出品タイトルからBELLO在庫(${resolution.resolved?.displayInventoryId})を特定しました。`]
          : resolution.candidates.length > 0
            ? [`対象商品：出品タイトルに一致する在庫が${resolution.candidates.length}件あり、1件に絞れませんでした。`]
            : ["対象商品：出品タイトルに一致するBELLO在庫が見つかりませんでした。"],
    };
  } catch (err) {
    return {
      ...empty,
      notes: [`在庫の照合に失敗しました: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * 1通のメールから分かる注文情報を対応表へ書く(§51/§64)。
 *
 * 購入通知でも取引メッセージでも同じ処理。**商品名が取れているなら、
 * その場で在庫まで解決して保存する** —— 後続の取引メッセージが
 * 再解析しなくて済むようにするのがこの表の目的(§51)。
 *
 * @returns 保存した対応。注文番号が無い(通常の商品問い合わせ)なら null。
 */
export async function recordOrderContextFromMail(params: {
  parsed: MercariMailParseResult;
  gmailId: string;
  receivedAt: string;
  who: string | null;
  /** 在庫の解決まで行うか。既に解決済みの注文では省ける。 */
  resolveProduct?: boolean;
}): Promise<MercariOrderContextRecord | null> {
  const { parsed } = params;
  const orderId = canonicalOrderId(parsed.order.orderNumber);
  if (!orderId) return null;

  const evidenceSource: OrderContextEvidenceSource =
    parsed.kind === "PURCHASE_NOTIFICATION" ? "PURCHASE_NOTIFICATION" : "ORDER_MESSAGE";

  const existing = await getMercariOrderContext(orderId);
  const productName = parsed.productName?.trim() || existing?.productName || null;

  // 在庫の解決は重い(全在庫スキャン)。既に確定しているならやり直さない
  // ——「同じ注文番号から毎回ゼロから商品特定する構造にはしない」(§51)。
  const needsResolve =
    params.resolveProduct !== false && Boolean(productName) && existing?.inventoryStatus !== "RESOLVED";
  const resolved = needsResolve && productName ? await runWithDirectData(() => resolveOrderProduct(productName)) : null;

  return upsertMercariOrderContext(orderId, {
    productName,
    productPriceYen: parsed.productPriceYen,
    quantity: parsed.quantity,
    itemAmountYen: parsed.order.itemAmountYen,
    shippingFeeYen: parsed.order.shippingFeeYen,
    couponDiscountYen: parsed.order.couponDiscountYen,
    totalAmountYen: parsed.order.totalAmountYen,
    shopId: parsed.shopId,
    orderUrl: parsed.orderUrl,
    evidenceSource,
    purchaseNotificationSeen: parsed.kind === "PURCHASE_NOTIFICATION",
    purchasedAt: parsed.kind === "PURCHASE_NOTIFICATION" ? params.receivedAt : undefined,
    inventoryId: resolved?.inventoryId ?? undefined,
    displayInventoryId: resolved?.displayInventoryId ?? undefined,
    inventoryName: resolved?.inventoryName ?? undefined,
    inventoryCandidateIds: resolved?.inventoryCandidateIds ?? undefined,
    inventoryStatus: resolved?.inventoryStatus ?? undefined,
    resolvedAt: resolved?.inventoryStatus === "RESOLVED" ? new Date().toISOString() : undefined,
    baseItemId: resolved?.baseItemId ?? undefined,
    baseUrl: resolved?.baseUrl ?? undefined,
    addInquiryIds: parsed.inquiryId ? [parsed.inquiryId] : [],
    addSourceGmailIds: [params.gmailId],
    // 取り込みの重複判定に使うのは**購入通知だけ**(§63 購入通知は Message を
    // 作らない)。取引メッセージのIDまで入れると、Message の作成に失敗した
    // 問い合わせが「処理済み」に見えて二度と取り込まれなくなる。
    addPurchaseMailGmailIds: parsed.kind === "PURCHASE_NOTIFICATION" ? [params.gmailId] : [],
    updatedBy: params.who,
  });
}
