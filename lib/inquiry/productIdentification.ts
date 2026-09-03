import type { ProductReferenceResult } from "./references";
import type { ProductResolution } from "./types";

/**
 * 「この商品で回答してよいか」の判定。
 *
 * ── 確信度だけでは足りない ──────────────────────────────────────
 *
 * 既存の照合は confidence（0〜1）と status（RESOLVED / AMBIGUOUS / …）を
 * 返す。しかし**同じ RESOLVED でも、何を根拠に決まったかで信頼度が違う**。
 *
 *   商品URLの商品IDで決まった  … 顧客が名指ししている。取り違えようがない
 *   SKU / 在庫IDで決まった      … 同上
 *   商品名の断片だけで決まった  … 「アンティークチェア」で0.9出ても、
 *                                 同名・類似商品があれば別物かもしれない
 *
 * 最後のものを「確信度が高いから」と通すと、**別の商品の価格・寸法・
 * 仕入情報を答えてしまう**。値下げ交渉の場面でこれが起きると実害になる。
 *
 * そこで確信度とは別に「何で特定したか」を持ち、名前だけで決まった場合は
 * 回答せずURLを尋ねる。
 *
 * ── 逆方向の誤りも避ける ────────────────────────────────────────
 *
 * URLで確実に特定できているのに「URLを送ってください」と返すのは、
 * 顧客からすると話を聞いていないのと同じ。特定できているときは
 * **確認を挟まない**。
 */

/** 何を根拠に商品が決まったか。上ほど強い。 */
export type IdentificationBasis =
  /** BASE商品URLの商品IDで決まった。顧客が名指ししている。 */
  | "BASE_ITEM_ID"
  /** SKU・在庫ID・型番など、一意なコードで決まった。 */
  | "STRONG_CODE"
  /** 会話に元から紐づいている、または担当者が選んだ。 */
  | "OPERATOR_OR_CONVERSATION"
  /** 商品名・ブランド名の一致だけで決まった。**一意である保証が無い。** */
  | "NAME_ONLY"
  /** 決まっていない。 */
  | "NONE";

export interface IdentificationInput {
  status: ProductResolution["status"];
  /** 照合に使った手がかり。 */
  references: Pick<ProductReferenceResult, "baseItemIds" | "skus" | "inventoryIds" | "modelNumbers">;
  /** 担当者が選んだ、または会話に紐づいていた商品で決まったか。 */
  fromOperatorOrConversation?: boolean;
  /** 候補の件数（RESOLVED でも2位以下が残る）。 */
  candidateCount: number;
}

export function identificationBasis(input: IdentificationInput): IdentificationBasis {
  if (input.status !== "RESOLVED") return "NONE";
  if (input.fromOperatorOrConversation) return "OPERATOR_OR_CONVERSATION";
  if (input.references.baseItemIds.length > 0) return "BASE_ITEM_ID";
  if (
    input.references.skus.length > 0 ||
    input.references.inventoryIds.length > 0 ||
    input.references.modelNumbers.length > 0
  ) {
    return "STRONG_CODE";
  }
  return "NAME_ONLY";
}

/**
 * 担当者向けカードに載せてよいBASE商品ページを選ぶ。
 *
 * ── 先頭を採ってはいけない ──────────────────────────────────────
 *
 * resolveProductFromInquiry が返す baseProducts は「URLから見つかった
 * BASE商品」の一覧で、**並び順は照合結果と無関係**。商品URLが複数ある
 * ときは全URLのタイトルをまとめて手がかりにして在庫を1件へ絞るため、
 * どのURLがその在庫に対応するかは照合の途中で失われている。先頭を採ると
 * 別商品のページを「この商品のページ」として見せてしまう。
 *
 * ── 担当者選択・会話紐付けも同じ ────────────────────────────────
 *
 * basis が OPERATOR_OR_CONVERSATION のとき、商品はURLとは無関係に
 * 決まっている。productResolver の「候補0件だが会話に紐づく商品がある」
 * 経路は、**照合に失敗したURLを baseProducts に載せたまま**返すので、
 * ここで弾かないと無関係な商品ページへの導線が出る。
 *
 * 結び付けられなかったURLは件数だけ画面に出して、担当者に選び直させる。
 */
export function linkedBaseProduct<T>(basis: IdentificationBasis, baseProducts: readonly T[]): T | null {
  if (basis !== "BASE_ITEM_ID") return null;
  // 2件以上ある時点で、どれがこの在庫のものか決められない。
  return baseProducts.length === 1 ? baseProducts[0] : null;
}

/** その根拠で、商品固有の内容を答えてよいか。 */
export function canAnswerProductSpecifics(basis: IdentificationBasis): boolean {
  return basis === "BASE_ITEM_ID" || basis === "STRONG_CODE" || basis === "OPERATOR_OR_CONVERSATION";
}

export interface UrlRequestDecision {
  /** URLを送ってもらう返信にするか。 */
  requestUrl: boolean;
  basis: IdentificationBasis;
  /** なぜそう判断したか。画面と記録に出す。 */
  reason: string;
}

/**
 * URL送付を依頼すべきかを決める。
 *
 * **商品固有の質問でないなら依頼しない。** 「営業時間は？」に対して
 * 商品URLを求めるのは的外れ。
 */
export function decideUrlRequest(params: {
  basis: IdentificationBasis;
  status: ProductResolution["status"];
  candidateCount: number;
  /** 商品が決まらないと答えられない質問か。 */
  requiresProduct: boolean;
  /**
   * 顧客が商品URLを送れる立場にあるか(2026-09-03 追加指示§4)。
   *
   * メルカリShopsのメール経由の問い合わせでは false。顧客は既に商品ページ
   * から問い合わせており、**こちらが商品を紐付けられなかっただけ**。
   * それを理由にURLの再送を頼むのは、内部の失敗を顧客へ転嫁している。
   */
  customerCanProvideUrl?: boolean;
}): UrlRequestDecision {
  const { basis, status, candidateCount, requiresProduct } = params;
  const customerCanProvideUrl = params.customerCanProvideUrl ?? true;

  if (!requiresProduct) {
    return { requestUrl: false, basis, reason: "商品が決まらなくても答えられる問い合わせです。" };
  }
  // §4 顧客がURLを送れない経路では、URLを尋ねる返信を作らない。
  // 商品が特定できないことは社内側で【要確認】として扱う。
  if (!customerCanProvideUrl) {
    return {
      requestUrl: false,
      basis,
      reason:
        "顧客が商品URLを送れる経路ではないため、URLの送付は依頼しません。商品を特定できない場合は社内で確認してください。",
    };
  }
  if (canAnswerProductSpecifics(basis)) {
    return { requestUrl: false, basis, reason: "商品を一意に特定できているため、確認は不要です。" };
  }
  if (basis === "NAME_ONLY") {
    return {
      requestUrl: true,
      basis,
      reason:
        candidateCount > 1
          ? `商品名の一致だけで決まっており、類似候補が${candidateCount}件あります。別商品の可能性があります。`
          : "商品名の一致だけで決まっており、同名・類似商品と取り違える可能性があります。",
    };
  }
  if (status === "AMBIGUOUS") {
    return { requestUrl: true, basis, reason: `候補が${candidateCount}件あり、どの商品か確定できていません。` };
  }
  if (status === "NOT_FOUND") {
    return { requestUrl: true, basis, reason: "手がかりに一致する在庫が見つかりませんでした。" };
  }
  return { requestUrl: true, basis, reason: "対象商品を特定できる情報が見つかりませんでした。" };
}

/**
 * URL送付を依頼する文面。
 *
 * 指示書の基本形をそのまま使う。BELLOの顧客対応は敬語の一貫性を
 * 別の層（lib/inquiry/keigo.ts）で整えるので、ここでは素の基本形を返し、
 * 口調の調整はそちらに任せる —— 2箇所で文体を持つと必ずずれる。
 */
export const PRODUCT_URL_REQUEST_TEMPLATE =
  "商品を正確に確認させていただくため、お問い合わせいただいている商品のURLをお送りいただけますでしょうか。確認でき次第、ご案内させていただきます。";

/** 商品を取り違えたまま答えてはいけない話題。 */
export const PRODUCT_SPECIFIC_TOPICS = [
  "値下げ",
  "価格",
  "サイズ",
  "寸法",
  "配送",
  "送料",
  "在庫",
  "商品状態",
  "コンディション",
  "仕入",
] as const;
