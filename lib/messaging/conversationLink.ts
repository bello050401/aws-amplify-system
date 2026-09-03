/**
 * 受信メッセージをどの会話へ入れるか(2026-09-03 追加指示 §19)。
 *
 * 純粋関数のみ。候補の会話は呼び出し側が読んで渡す。
 *
 * ── 名前だけで結合しない ────────────────────────────────────────
 *
 * 同姓同名と表記揺れがあるので、氏名は主キーにならない。「山田様」から
 * 届いた問い合わせを、無関係な別の「山田様」の会話へ入れてしまうと、
 * 前の会話の商品・価格・住所がそのまま新しい顧客への返信に混ざる。
 * これは取り違えの中でも最悪の部類なので、**名前の一致だけでは絶対に
 * 結合しない**。
 *
 * ── ただし名前を捨てもしない ────────────────────────────────────
 *
 * チャネル側の安定した顧客IDが取れないことがある。そのとき名前を
 * 使わないと、会話が毎回切れて文脈が失われる —— それが今回直している
 * 不具合そのものである。
 *
 * そこで名前は**単独では効かない補助情報**として扱い、
 *
 *   ・直近の、まだ終わっていない会話であること
 *   ・時間的に近いこと
 *   ・直前にこちらが質問していること(その答えとして届いた)
 *   ・商品/問い合わせ文脈が続いていること
 *
 * のいずれかと組み合わさったときだけ結合する。とくに
 * 「こちらが確認質問を出した直後に、同じ名前から短い回答が届いた」場合は
 * 最優先で既存会話の続きとして扱う —— これを取りこぼすと
 * 「埼玉です」が新規問い合わせになる。
 *
 * ── 決められないときは結合しない ────────────────────────────────
 *
 * 同じ条件を満たす候補が2件以上あるなら、どちらか一方へ入れる根拠が無い。
 * 新しい会話として扱い、担当者が結合を判断する。誤って混ぜるより、
 * 分かれているほうが後から直せる。
 */

/** 判定に必要な、既存会話の要点。 */
export interface ConversationCandidate {
  id: string;
  channel: string;
  externalCustomerId: string | null;
  externalConversationId: string | null;
  customerDisplayName: string | null;
  /** 最終メッセージ日時(ISO)。 */
  lastMessageAt: string | null;
  /** こちらが最後に返信した日時(ISO)。 */
  lastOutgoingAt: string | null;
  /** 会話が終了扱いか(RESOLVED / ARCHIVED)。 */
  status: string | null;
  /** この会話で特定済みのBASE商品ID。 */
  relatedBaseItemId: string | null;
  /** いま顧客の回答を待っている項目があるか(会話文脈から導出して渡す)。 */
  hasPendingQuestion: boolean;
  /** 論理削除済みなら結合しない。 */
  deletedAt: string | null;
}

export interface IncomingIdentity {
  channel: string;
  /** チャネル側の顧客ID(LINEの source.userId 等)。取れないことがある。 */
  externalCustomerId: string | null;
  /** チャネル側の会話ID(メルカリShopsの inquiryId 等)。 */
  externalConversationId: string | null;
  customerDisplayName: string | null;
  /** 受信日時(ISO)。 */
  receivedAt: string;
  /** 本文から取れたBASE商品ID。文脈の継続性の判定に使う。 */
  baseItemIds: string[];
}

export type LinkBasis =
  | "EXTERNAL_CONVERSATION_ID"
  | "EXTERNAL_CUSTOMER_ID"
  | "DISPLAY_NAME_AND_PENDING_QUESTION"
  | "DISPLAY_NAME_AND_PRODUCT_CONTEXT";

export interface LinkDecision {
  conversationId: string | null;
  basis: LinkBasis | null;
  /** なぜそう判断したか。監査と通知に出す。 */
  reason: string;
}

/**
 * 確認質問への回答とみなす時間の幅。
 *
 * 質問への返事は普通その日のうちに来る。長くしすぎると、何日も経ってから
 * 届いた別件を回答として取り違える。
 */
export const PENDING_ANSWER_WINDOW_HOURS = 48;

/** 商品文脈が続いているとみなす時間の幅。回答よりは長く見る。 */
export const PRODUCT_CONTEXT_WINDOW_HOURS = 24 * 14;

const FINISHED_STATUSES = new Set(["RESOLVED", "ARCHIVED"]);

function hoursBetween(a: string | null, b: string): number | null {
  if (!a) return null;
  const from = Date.parse(a);
  const to = Date.parse(b);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (to - from) / (60 * 60 * 1000);
}

/**
 * 表示名の照合用に整える。
 *
 * 全角空白・空白・記号のゆれで別人にしない。ただし**正規化しても
 * 別人は別人**なので、これは「同じ名前か」を見るだけで、
 * 同一人物の判定はしていない。
 */
export function normalizeDisplayName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, "")
    .replace(/[様さんちゃん]+$/u, "")
    .toLowerCase();
}

function isOpen(candidate: ConversationCandidate): boolean {
  if (candidate.deletedAt) return false;
  return !FINISHED_STATUSES.has(candidate.status ?? "");
}

/**
 * 受信メッセージを入れる会話を決める。
 *
 * 候補は「同じチャネルの会話」を呼び出し側が渡す。ここでチャネルの
 * 一致も念のため確認する —— LINEの会話へメールを入れるような取り違えは、
 * 判定の順序を変えたときに簡単に起きる。
 */
export function decideConversationLink(
  incoming: IncomingIdentity,
  candidates: ConversationCandidate[],
): LinkDecision {
  const sameChannel = candidates.filter((c) => c.channel === incoming.channel);

  // ① チャネル固有の会話ID。最も強い(メルカリShopsの inquiryId 等)。
  if (incoming.externalConversationId) {
    const hit = sameChannel.filter((c) => c.externalConversationId === incoming.externalConversationId);
    if (hit.length === 1) {
      return {
        conversationId: hit[0].id,
        basis: "EXTERNAL_CONVERSATION_ID",
        reason: `チャネル側の会話ID(${incoming.externalConversationId})が一致しました。`,
      };
    }
    if (hit.length > 1) {
      return {
        conversationId: hit[0].id,
        basis: "EXTERNAL_CONVERSATION_ID",
        reason: `チャネル側の会話IDが一致する会話が${hit.length}件あり、最初の1件へ入れました。`,
      };
    }
  }

  // ② チャネル固有の顧客ID(LINEの userId 等)。
  if (incoming.externalCustomerId) {
    const hit = sameChannel.filter((c) => c.externalCustomerId === incoming.externalCustomerId);
    if (hit.length > 0) {
      return {
        conversationId: hit[0].id,
        basis: "EXTERNAL_CUSTOMER_ID",
        reason: "チャネル側の顧客IDが一致しました。",
      };
    }
    // 顧客IDが取れているのに一致が無いなら、新規顧客。名前で探しにいかない
    // —— 同姓同名を統合してしまう。
    return { conversationId: null, basis: null, reason: "この顧客IDの会話はまだありません。新しい会話にします。" };
  }

  // ③ 顧客IDが取れない場合だけ、表示名を補助情報として使う。
  const name = normalizeDisplayName(incoming.customerDisplayName);
  if (!name) {
    return { conversationId: null, basis: null, reason: "顧客IDも表示名も無いため、新しい会話にします。" };
  }

  const byName = sameChannel.filter((c) => isOpen(c) && normalizeDisplayName(c.customerDisplayName) === name);
  if (byName.length === 0) {
    return { conversationId: null, basis: null, reason: "同じ表示名の未完了の会話がないため、新しい会話にします。" };
  }

  // ③-a 直前にこちらが質問していて、その回答として届いた場合。最優先。
  const answering = byName
    .filter((c) => c.hasPendingQuestion && c.lastOutgoingAt)
    .map((c) => ({ c, hours: hoursBetween(c.lastOutgoingAt, incoming.receivedAt) }))
    .filter((x) => x.hours != null && x.hours >= 0 && x.hours <= PENDING_ANSWER_WINDOW_HOURS)
    .sort((a, b) => (a.hours as number) - (b.hours as number));

  if (answering.length === 1) {
    return {
      conversationId: answering[0].c.id,
      basis: "DISPLAY_NAME_AND_PENDING_QUESTION",
      reason: `同じ表示名で、こちらの確認事項に${Math.round(answering[0].hours as number)}時間以内で回答が届いたため、既存の会話の続きとして扱いました。`,
    };
  }
  if (answering.length > 1) {
    return {
      conversationId: null,
      basis: null,
      reason: `同じ表示名で回答待ちの会話が${answering.length}件あり、どれへの回答か決められないため新しい会話にします。`,
    };
  }

  // ③-b 商品文脈が続いている場合(同じBASE商品の話が続いている)。
  if (incoming.baseItemIds.length > 0) {
    const sameProduct = byName
      .filter((c) => c.relatedBaseItemId && incoming.baseItemIds.includes(c.relatedBaseItemId))
      .map((c) => ({ c, hours: hoursBetween(c.lastMessageAt, incoming.receivedAt) }))
      .filter((x) => x.hours != null && x.hours >= 0 && x.hours <= PRODUCT_CONTEXT_WINDOW_HOURS)
      .sort((a, b) => (a.hours as number) - (b.hours as number));
    if (sameProduct.length === 1) {
      return {
        conversationId: sameProduct[0].c.id,
        basis: "DISPLAY_NAME_AND_PRODUCT_CONTEXT",
        reason: "同じ表示名で、同じ商品についてのやり取りが続いているため、既存の会話の続きとして扱いました。",
      };
    }
    if (sameProduct.length > 1) {
      return {
        conversationId: null,
        basis: null,
        reason: `同じ表示名・同じ商品の会話が${sameProduct.length}件あり、決められないため新しい会話にします。`,
      };
    }
  }

  // ③-c 名前が一致するだけ。**結合しない。**
  return {
    conversationId: null,
    basis: null,
    reason:
      "表示名が一致する会話はありますが、確認事項への回答でも同じ商品の継続でもないため、名前だけでは結合しません。",
  };
}
