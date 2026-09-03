/**
 * 2026-09-03 指示書 §7/§33/§34: 社内LINE Botへ送る2通の文面を組み立てる。
 *
 * ── ここは純粋関数だけ ──────────────────────────────────────────
 *
 * AWSにもLINEにも触らない。文面の正しさは「実際に送ってみる」ことでしか
 * 確かめられない、という状態にしない —— 通知は失敗しても再試行できるが、
 * **間違った金額や別商品の情報を送ってしまうと取り返しがつかない**。
 * だからここだけを切り出して、scripts/verify-line-notify.ts で全分岐を
 * 固定する。
 *
 * ── 推測して埋めない ────────────────────────────────────────────
 *
 * §7-2 が明示している。分からない値は「不明」、商品が決まらなければ
 * 「特定できませんでした」と書く。**それらしい値を置かない。**
 * 値が無いことは、担当者にとって「調べる必要がある」という情報であって、
 * 埋めてしまうとその判断材料を奪う。
 *
 * ただし「取得できるのに取りに行かずに不明にする」のも禁止(§7-2 末尾)。
 * この関数は渡された evidence の中身をすべて使い切る。取りに行く責任は
 * lib/inquiry/pipeline.ts 側にある。
 */
import { INQUIRY_INTENT_LABEL, type InquiryIntent, type ReplyEvidence } from "@/lib/inquiry/types";
import { MESSAGE_CHANNEL_LABEL, type MessageChannel } from "@/lib/messaging/types";

/** 値が無いときの表記。§7-2。 */
const UNKNOWN = "不明";
const PRODUCT_UNIDENTIFIED = "特定できませんでした";

/**
 * LINEのテキストメッセージ1通の上限は5,000文字。
 * 上限を超えると送信そのものが失敗し、**通知が1件丸ごと届かない**。
 * 途中で切ってでも届けるほうが、届かないより良い。
 */
export const LINE_TEXT_LIMIT = 5000;

/** 問い合わせ本文の引用が長すぎると、判断材料が下へ押し出されて読めなくなる。 */
const QUOTED_BODY_LIMIT = 1200;

export type NotificationPriority = "NORMAL" | "ATTENTION" | "URGENT" | "PARSE_ERROR";

export interface NotificationInput {
  channel: MessageChannel;
  /** 顧客名。取れなければ null(「不明」と書く)。 */
  customerName: string | null;
  /** 顧客が送ってきた本文そのもの。 */
  messageText: string;
  intents: InquiryIntent[];
  /** lib/inquiry/pipeline.ts が返す根拠一式。生成に失敗したときは null。 */
  evidence: ReplyEvidence | null;
  /** 2通目に載せる返信案。生成できなかったときは null。 */
  draftText: string | null;
  /** 人間の判断が必要か。true なら1通目の先頭へ【要確認】を付ける(§33)。 */
  needsHumanReview: boolean;
  /** なぜ人間の判断が必要か。担当者が何を決めればよいか分かるように書く。 */
  reviewReasons: string[];
  /** AI生成が失敗したときの管理画面ログID(§34)。 */
  logId: string | null;
  /** AI生成が失敗した理由(担当者向けの短い日本語)。 */
  failureReason: string | null;
  /**
   * メール由来の問い合わせ種別(§9)。見出しを分ける。
   *
   * 通常の商品問い合わせと、購入済み注文への取引メッセージは、
   * 担当者の対応が全く違う(前者は販売前、後者は発送・日程の調整)。
   * 見出しで即座に区別できないと、読み違えたまま返信してしまう。
   */
  inquiryKind?: "PRODUCT_INQUIRY" | "ORDER_MESSAGE" | null;
  /** 取引メッセージの注文番号(§9 1通目に出す)。 */
  orderNumber?: string | null;
}

export interface NotificationMessages {
  /** 1通目。問い合わせ内容と判断材料。 */
  summary: string;
  /** 2通目。返信提案。生成できていなければ null(1通だけ送る)。 */
  reply: string | null;
  priority: NotificationPriority;
}

function yen(v: number | null | undefined): string {
  return v == null ? UNKNOWN : `${v.toLocaleString("ja-JP")}円`;
}

/** ISO日付 → 「2026年8月15日」。時刻は落とす(§7-1 の例が日付までのため)。 */
function jaDate(v: string | null | undefined): string {
  if (!v) return UNKNOWN;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  // 販売開始日は date 型(タイムゾーンを持たない)。UTCで読むと日本時間で
  // 1日ずれるので、UTCの暦日をそのまま日本の日付として読む。
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/**
 * 在庫期間(日)。staffCard が計算済みならそれを使い、無ければ販売開始日から
 * 出す。**両方無ければ「不明」**で、0日と書かない。
 */
function inventoryAgeDays(evidence: ReplyEvidence | null): number | null {
  const fromCard = evidence?.staffCard?.daysOnSale;
  if (fromCard != null) return fromCard;
  const start = evidence?.identifiedProduct?.saleStartedAt;
  if (!start) return null;
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days >= 0 ? days : null;
}

/**
 * ■見出しと中身。中身が1行も無いセクションは丸ごと出さない(空見出しを残さない)。
 *
 * **null と空文字を区別する。** null は「その行は出さない」、空文字は
 * 「意図的な空行」。§7-1 のテンプレートはお名前と本文の間に空行を置いて
 * いて、そこを詰めると読みづらくなる(名前と問い合わせ文が続けて並ぶ)。
 * 一律に空文字も落とすと、その空行まで消える。
 */
function section(heading: string, lines: (string | null)[]): string | null {
  const kept = lines.filter((l): l is string => l !== null);
  // 実際に中身がある行が1つも無ければ、見出しごと出さない。
  if (kept.every((l) => l.trim() === "")) return null;
  return [`■ ${heading}`, ...kept].join("\n");
}

/**
 * 1通目。§7-1 のテンプレートに沿う。
 *
 * 【対象商品を1件に決めつけない】商品が特定できていないときは商品名や
 * URLの欄自体を出さず「特定できませんでした」とだけ書く。候補の1つを
 * 載せると、担当者がそれを確定した商品だと思い込む(メッセージ画面の
 * 対象商品カードと同じ方針 — IdentifiedProductCardView 参照)。
 */
export function buildSummaryMessage(input: NotificationInput): string {
  // §9 チャネル名に問い合わせ種別を足す。メルカリShopsは「お問い合わせ」と
  // 「取引メッセージ」で担当者の動きが違うので、見出しで区別する。
  const kindLabel =
    input.inquiryKind === "ORDER_MESSAGE" ? "取引メッセージ" : input.inquiryKind === "PRODUCT_INQUIRY" ? "お問い合わせ" : null;
  const channelLabel = kindLabel
    ? `${MESSAGE_CHANNEL_LABEL[input.channel]}｜${kindLabel}`
    : MESSAGE_CHANNEL_LABEL[input.channel];
  const header = input.needsHumanReview ? `【${channelLabel} / 要確認】` : `【${channelLabel}】`;

  const product = input.evidence?.identifiedProduct ?? null;
  const shipping = input.evidence?.shipping ?? null;
  const ageDays = inventoryAgeDays(input.evidence);

  const intentText =
    input.intents.length > 0 ? input.intents.map((i) => INQUIRY_INTENT_LABEL[i]).join("・") : UNKNOWN;

  // 各要素は "\n\n" で連結する。ここへ空文字を挟むと空行が2つ並ぶ。
  const parts: (string | null)[] = [
    header,
    section("お問い合わせ内容", [
      `お名前：${input.customerName ?? UNKNOWN}`,
      "",
      truncate(input.messageText.trim(), QUOTED_BODY_LIMIT),
    ]),
    section(
      "対象商品",
      product
        ? [
            `商品名：${product.name}`,
            `在庫ID：${product.displayInventoryId}`,
            // URLは商品と1対1で結び付いたときだけ入る(pipeline.ts の
            // linkedBaseProduct)。無ければ行ごと出さない —— 「URL：不明」は
            // 担当者にとって意味が無く、行が増えるだけ。
            product.baseItemUrl ? `URL：${product.baseItemUrl}` : null,
          ]
        : [PRODUCT_UNIDENTIFIED],
    ),
    // 商品が決まっていないのに価格欄を出さない。空欄が並ぶと
    // 「取得に失敗した」のか「そもそも商品が決まっていない」のか読めない。
    product
      ? section("商品情報", [
          `販売価格：${yen(product.salePriceYen)}`,
          `仕入れ価格：${yen(product.purchasePriceYen)}`,
          `販売開始日：${jaDate(product.saleStartedAt)}`,
          `在庫期間：${ageDays == null ? UNKNOWN : `${ageDays}日`}`,
        ])
      : null,
    section("配送情報", [
      `配送先：${shipping?.destinationPrefecture ?? UNKNOWN}`,
      `想定送料：${yen(shipping?.feeYen ?? null)}`,
    ]),
    // §9 取引メッセージなら注文番号を1通目に出す。担当者が管理画面で
    // 注文を引くときにそのまま使える。
    input.orderNumber ? section("注文情報", [`注文番号：${input.orderNumber}`]) : null,
    section("問い合わせ判定", [intentText]),
    // なぜ人が判断する必要があるのかを必ず書く。【要確認】だけ付けて
    // 理由を書かないと、担当者が何を決めればよいか分からない。
    input.needsHumanReview && input.reviewReasons.length > 0
      ? section("要確認の理由", input.reviewReasons.map((r) => `・${r}`))
      : null,
    // §34 生成に失敗しても問い合わせ自体は無視しない。
    input.failureReason
      ? section("返信案", [
          "返信案の自動生成に失敗しました。",
          input.failureReason,
          input.logId ? `管理画面ログID：${input.logId}` : null,
        ])
      : null,
  ];

  return truncate(parts.filter((p): p is string => p !== null).join("\n\n"), LINE_TEXT_LIMIT);
}

/**
 * 2通目。§7-3。
 *
 * **そのままコピーして顧客へ送れる完成文だけを入れる。** 「以下のように
 * 返信するとよいでしょう」のようなAIの解説は入れない —— 担当者がコピーの
 * たびに解説行を削る運用は必ず事故る(消し忘れがそのまま顧客へ届く)。
 * 見出しの【返信提案】だけは、1通目と区別するために必要なので残す。
 */
export function buildReplyMessage(draftText: string): string {
  return truncate(`【返信提案】\n\n${draftText.trim()}`, LINE_TEXT_LIMIT);
}

function decidePriority(input: NotificationInput): NotificationPriority {
  if (input.failureReason) return "PARSE_ERROR";
  if (input.needsHumanReview) return "ATTENTION";
  return "NORMAL";
}

/**
 * 送る2通を組み立てる。返信案が無ければ2通目は null(1通だけ送る) ——
 * 空の【返信提案】を送ると、担当者は「生成されたが中身が無い」と読む。
 */
export function buildNotificationMessages(input: NotificationInput): NotificationMessages {
  const draft = input.draftText?.trim();
  return {
    summary: buildSummaryMessage(input),
    reply: draft ? buildReplyMessage(draft) : null,
    priority: decidePriority(input),
  };
}
