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
  /**
   * 会話から引き継いだ情報(2026-09-03 追加指示 §27)。
   *
   * 後続メッセージだと、1通目に出るのが「埼玉です」だけになる。それでは
   * 担当者は**何の話か分からないまま返信案の可否を判断する**ことになる。
   * 今回の判断に使った文脈を並べて、その場で読めるようにする。
   */
  carriedFacts?: { label: string; value: string }[];
  /** 今回のメッセージで解消した確認事項(§22)。 */
  answeredQuestions?: string[];
  /** 商品情報をどこから補完したか(§33「サイズ：BASE商品ページから補完」)。 */
  productContextNotes?: string[];
  /** 会話文脈の読み書きで起きた問題。黙って成功にしない。 */
  contextIssues?: string[];
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
 * 在庫行を見分けるための注記。商品名の先頭の【…】がそれにあたる
 * (「【小傷あり】」「【在庫2】」)。同じ商品の行を並べるので、
 * 商品名を丸ごと繰り返しても読みづらいだけ。
 */
function stockRowLabel(name: string): string {
  const m = name.match(/^(?:\s*【[^】]*】)+/u);
  return m ? m[0].trim() : "";
}

/**
 * ■対象商品 の中身。
 *
 * 【1件に決めつけない】在庫を1件に絞れていないときに候補の1つを載せると、
 * 担当者がそれを確定した商品だと思い込む(メッセージ画面の対象商品カードと
 * 同じ方針 — IdentifiedProductCardView 参照)。
 *
 * 【ただし分かっている分は捨てない】以前は在庫が確定しない限り
 * 「特定できませんでした」の一行だけだった。実機で、顧客が送ってきた
 * BASEの商品URLから**販売ページは確実に特定できていた**のに、同名の在庫が
 * 2件あって絞れないという理由だけで、商品名も出品価格も伏せていた。
 * 担当者から見れば「何も分からなかった」と読めてしまい、実際には
 * 手元にある情報を捨てている。
 *
 * 販売ページは顧客が指したものそのものなので確実に書ける。伏せるべきなのは
 * **どの在庫か**の一点だけなので、そこを候補として明示する。
 */
function productLines(evidence: ReplyEvidence | null | undefined): (string | null)[] {
  const product = evidence?.identifiedProduct ?? null;
  if (product) {
    // 同じ商品を傷の有無や在庫数で複数行に分けている場合、返信は1商品と
    // して扱ってよいが、**担当者はどの行が何点あるかで出荷を判断する**ので
    // 内訳を出す(2026-09-03 利用者指示)。
    const rows = product.stockRows ?? [];
    const breakdown =
      rows.length > 1
        ? [
            `在庫：計${product.totalQuantity == null ? UNKNOWN : `${product.totalQuantity}点`}`,
            ...rows.map((r) => `　・${r.displayInventoryId}${stockRowLabel(r.name)} ${r.quantity == null ? UNKNOWN : `${r.quantity}点`}`),
          ]
        : [];

    return [
      `商品名：${product.name}`,
      // まとめた場合、代表1行の在庫IDだけを出すと「その行の商品」と
      // 読めてしまう。内訳を出すときは在庫IDの単独行を出さない。
      rows.length > 1 ? null : `在庫ID：${product.displayInventoryId}`,
      // URLは商品と1対1で結び付いたときだけ入る(pipeline.ts の
      // linkedBaseProduct)。無ければ行ごと出さない —— 「URL：不明」は
      // 担当者にとって意味が無く、行が増えるだけ。
      product.baseItemUrl ? `URL：${product.baseItemUrl}` : null,
      ...breakdown,
    ];
  }

  const base = (evidence?.baseProducts ?? [])[0] ?? null;
  const candidates = evidence?.productCandidates ?? [];
  if (!base) {
    // 販売ページも分からない。候補だけはある場合、件数は出す
    // (「調べる必要がある」ことと「候補すら無い」ことは別の情報)。
    if (candidates.length > 0) {
      return [PRODUCT_UNIDENTIFIED, `在庫の候補：${candidates.length}件（どれか確認してください）`];
    }
    return [PRODUCT_UNIDENTIFIED];
  }

  // 販売ページは確実。書けるものは書く。
  const ids = candidates
    .map((c) => c.displayInventoryId)
    .filter((v): v is string => Boolean(v));
  return [
    `販売ページ：${base.title}`,
    base.price == null ? null : `出品価格：${yen(base.price)}`,
    base.itemUrl ? `URL：${base.itemUrl}` : null,
    ids.length > 0
      ? `在庫：特定できていません（候補${candidates.length}件：${ids.join(" / ")}）`
      : "在庫：特定できていません",
  ];
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
    section("対象商品", productLines(input.evidence)),
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
    // §27 引き継いだ情報。今回の判断に使った文脈だけを並べる ——
    // 会話の全履歴を貼ると、肝心の判断材料が下へ押し出されて読めなくなる。
    input.carriedFacts && input.carriedFacts.length > 0
      ? section(
          "引き継いだ情報",
          input.carriedFacts.map((f) => `${f.label}：${f.value}`),
        )
      : null,
    input.answeredQuestions && input.answeredQuestions.length > 0
      ? section(
          "今回いただいた回答",
          input.answeredQuestions.map((r) => `・${r}`),
        )
      : null,
    // §33 どの情報でこの判断をしたか。送料が出せた/出せなかった理由の追跡に要る。
    input.productContextNotes && input.productContextNotes.length > 0
      ? section(
          "商品情報の補完",
          input.productContextNotes.map((r) => `・${r}`),
        )
      : null,
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
    // 会話の引き継ぎが働かなかったことは隠さない。担当者が
    // 「なぜ商品を引き継げていないのか」を追えるようにする。
    input.contextIssues && input.contextIssues.length > 0
      ? section(
          "引き継ぎの問題",
          input.contextIssues.map((r) => `・${r}`),
        )
      : null,
    // §27 1通目の最後は必ずこの1行。2通目が来ることを担当者へ知らせる。
    input.draftText && input.draftText.trim() ? "【次のメッセージで返信提案します】" : null,
  ];

  return truncate(parts.filter((p): p is string => p !== null).join("\n\n"), LINE_TEXT_LIMIT);
}

/**
 * 2通目。§7-3。
 *
 * **そのままコピーして顧客へ送れる完成文だけを入れる。** 「以下のように
 * 返信するとよいでしょう」のようなAIの解説は入れない —— 担当者がコピーの
 * たびに解説行を削る運用は必ず事故る(消し忘れがそのまま顧客へ届く)。
 * ── 見出しを付けない(2026-09-03 追加指示 §27) ───────────────────
 *
 * 以前は【返信提案】を先頭に付けていた。担当者はこの2通目を**そのまま
 * コピーして顧客へ送る**ので、見出しが残っていると顧客に見出しごと届く。
 * 1通目との区別は、1通目の末尾の【次のメッセージで返信提案します】が
 * 担っている —— 区別のために、送る側の文面を汚す必要は無い。
 */
export function buildReplyMessage(draftText: string): string {
  return truncate(draftText.trim(), LINE_TEXT_LIMIT);
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
